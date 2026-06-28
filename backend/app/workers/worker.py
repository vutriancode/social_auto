import asyncio
import logging
import re
import random
from datetime import datetime, timedelta, timezone
from typing import Optional
import httpx
import redis.asyncio as redis
from motor.motor_asyncio import AsyncIOMotorClient
from bson import ObjectId

from app.core.config import settings, ACCOUNT_COMMENT_COOLDOWN_MIN_SECONDS, ACCOUNT_COMMENT_COOLDOWN_MAX_SECONDS
from app.core.job_scheduling import X_MIN_GAP_SECONDS, X_MAX_GAP_SECONDS
from app.core.time_utils import parse_to_naive_utc, compute_next_fixed_time
from app.core.job_scheduling import build_account_cooldown_tracker, reserve_account_schedule
from app.services.social_mock import (
    SocialAuthError,
    SocialCheckpointError,
    mock_post_comment,
    parse_cookie_to_dict,
    post_comment_facebook,
    publish_post_facebook,
    extract_fb_post_id,
    fetch_random_post_photo,
    generate_ai_image,
)

# Configure logging for worker
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - worker - %(levelname)s - %(message)s"
)
logger = logging.getLogger("worker")

IMMEDIATE_QUEUE = "campaign_jobs_queue"
REFRESH_QUEUE = "account_refresh_queue"
SCHEDULED_QUEUE = "campaign_jobs_scheduled"




def extract_first_url(text: Optional[str]) -> Optional[str]:
    """Finds the first http(s) URL embedded in a piece of comment text, if any."""
    if not text:
        return None
    match = re.search(r"https?://\S+", text)
    if not match:
        return None
    return match.group(0).rstrip(".,;)\"'")


def resolve_stored_image_reference(raw_image_url: Optional[str]):
    """Resolves a stored image reference (local /api/media/ path or remote URL) into
    (image_url, image_data, image_filename) ready to hand to a Graph API call."""
    if not raw_image_url:
        return None, None, "image.jpg"
    if raw_image_url.startswith("/api/media/"):
        filename = raw_image_url.split("/api/media/", 1)[1]
        local_path = f"/app/static/uploads/{filename}"
        try:
            with open(local_path, "rb") as fh:
                return None, fh.read(), filename
        except OSError:
            return raw_image_url, None, "image.jpg"
    return raw_image_url, None, "image.jpg"


def normalize_monitor_page_urls(campaign: dict) -> list[str]:
    urls = []
    for value in [campaign.get("monitor_page_urls"), campaign.get("monitor_page_url")]:
        if not value:
            continue
        if isinstance(value, str):
            candidates = value.splitlines()
        elif isinstance(value, list):
            candidates = value
        else:
            continue

        for item in candidates:
            if not isinstance(item, str):
                continue
            url = item.strip().strip(",")
            if not url:
                continue
            if not url.lower().startswith(("http://", "https://")):
                url = f"https://{url}"
            if url.lower().startswith("https://threads.com/"):
                url = "https://www.threads.com/" + url[len("https://threads.com/"):]
            elif url.lower().startswith("https://threads.net/"):
                url = "https://www.threads.net/" + url[len("https://threads.net/"):]
            if url not in urls:
                urls.append(url)
    return urls


def spin_spintax(text: str) -> str:
    """
    Parses and spins spintax format like {hello|hi|hey} into a random choice.
    Supports nested spintax.
    """
    pattern = re.compile(r'{([^{}]+)}')
    while True:
        match = pattern.search(text)
        if not match:
            break
        options = match.group(1).split('|')
        text = text.replace(match.group(0), random.choice(options), 1)
    return text


class Worker:
    def __init__(self):
        self.redis_client = None
        self.mongo_client = None
        self.db = None
        self.running = True
        self.last_monitor_check = 0.0
        self.refresh_sem = asyncio.Semaphore(2)

    async def connect(self):
        logger.info(f"Connecting to MongoDB at {settings.MONGODB_URL}")
        self.mongo_client = AsyncIOMotorClient(settings.MONGODB_URL)
        self.db = self.mongo_client[settings.DATABASE_NAME]

        logger.info(f"Connecting to Redis at {settings.REDIS_URL}")
        self.redis_client = redis.from_url(settings.REDIS_URL, decode_responses=True)

    async def recover_interrupted_jobs(self):
        running_jobs = await self.db.jobs.find({"status": "RUNNING"}).to_list(length=1000)
        recovered = 0
        cancelled = 0
        for job in running_jobs:
            campaign = await self.db.campaigns.find_one({"_id": job["campaign_id"]})
            if campaign and campaign.get("status") == "RUNNING":
                await self.db.jobs.update_one(
                    {"_id": job["_id"], "status": "RUNNING"},
                    {"$set": {
                        "status": "QUEUED",
                        "scheduled_time": datetime.utcnow(),
                        "error_message": "Recovered after worker restart before completion."
                    }}
                )
                await self.redis_client.rpush(IMMEDIATE_QUEUE, str(job["_id"]))
                recovered += 1
            else:
                await self.db.jobs.update_one(
                    {"_id": job["_id"], "status": "RUNNING"},
                    {"$set": {
                        "status": "CANCELLED",
                        "completed_at": datetime.utcnow(),
                        "error_message": "Cancelled after worker restart because campaign is no longer running."
                    }}
                )
                cancelled += 1

        if recovered or cancelled:
            logger.warning(f"Recovered {recovered} interrupted RUNNING jobs and cancelled {cancelled}.")

    async def check_and_reset_limits(self, account: dict) -> dict:
        """
        Check if the account's usage count needs to be reset based on the time elapsed
        since last activity. Returns updated account dict.
        """
        now = datetime.utcnow()
        last_act = account.get("last_activity")
        last_act = parse_to_naive_utc(last_act)
        
        update_fields = {}
        
        if last_act:
            # Reset hourly count if the hour has changed
            if last_act.hour != now.hour or (now - last_act) > timedelta(hours=1):
                update_fields["hourly_usage_count"] = 0
                account["hourly_usage_count"] = 0
                
            # Reset daily count if the day has changed
            if last_act.day != now.day or (now - last_act) > timedelta(days=1):
                update_fields["daily_usage_count"] = 0
                account["daily_usage_count"] = 0
                
        if update_fields:
            # If account status was LIMITED due to rate limits, reset it to ACTIVE
            if account["status"] == "LIMITED":
                update_fields["status"] = "ACTIVE"
                account["status"] = "ACTIVE"
                
            await self.db.accounts.update_one(
                {"_id": account["_id"]},
                {"$set": update_fields}
            )
            logger.info(f"Reset usage limits for account @{account['username']}")
            
        return account

    async def handle_retry(self, job_id_str: str, job: dict, error_msg: str):
        attempt = job.get("attempt_count", 0) + 1
        db = self.db
        
        # Retry Delays:
        # Retry 1 -> 1 min (60s)
        # Retry 2 -> 5 mins (300s)
        # Retry 3 -> 15 mins (900s)
        delays = [60, 300, 900]
        
        if attempt <= 3:
            delay = delays[attempt - 1]
            run_at = datetime.utcnow() + timedelta(seconds=delay)
            logger.info(f"Scheduling job {job_id_str} for retry #{attempt} in {delay}s due to error: {error_msg}")
            
            # Update job status in database
            await db.jobs.update_one(
                {"_id": ObjectId(job_id_str)},
                {"$set": {
                    "status": "RETRYING",
                    "attempt_count": attempt,
                    "scheduled_time": run_at,
                    "error_message": f"Retry #{attempt}: {error_msg}"
                }}
            )
            await self.redis_client.zadd(SCHEDULED_QUEUE, {job_id_str: run_at.timestamp()})
        else:
            # Max retries exceeded
            logger.error(f"Job {job_id_str} failed after max retries. Error: {error_msg}")
            
            await db.jobs.update_one(
                {"_id": ObjectId(job_id_str)},
                {"$set": {
                    "status": "FAILED",
                    "completed_at": datetime.utcnow(),
                    "error_message": f"Failed after 3 attempts: {error_msg}"
                }}
            )
            
            # Update target URL to FAILED
            await db.target_urls.update_one(
                {"_id": job["url_id"]},
                {"$set": {
                    "status": "FAILED",
                    "processed_at": datetime.utcnow(),
                    "error_message": error_msg
                }}
            )
            
            # Reduce account health score by 5 points (min 0)
            account_id = job.get("account_id")
            if account_id:
                account = await db.accounts.find_one({"_id": account_id})
                if account:
                    new_score = max(0, account.get("health_score", 100) - 5)
                    # If health score drops below 50, mark account as ERROR/warning status
                    status_val = account["status"]
                    if new_score < 50 and status_val == "ACTIVE":
                        status_val = "ERROR"
                    await db.accounts.update_one(
                        {"_id": account_id},
                        {"$set": {"health_score": new_score, "status": status_val}}
                    )

    async def postpone_for_rate_limit(self, job_id_str: str, job: dict, account: dict):
        now = datetime.utcnow()
        hourly_limited = account["hourly_usage_count"] >= account["hourly_limit"]
        daily_limited = account["daily_usage_count"] >= account["daily_limit"]

        if daily_limited:
            run_at = (now + timedelta(days=1)).replace(hour=0, minute=0, second=5, microsecond=0)
        elif hourly_limited:
            run_at = (now + timedelta(hours=1)).replace(minute=0, second=5, microsecond=0)
        else:
            run_at = now + timedelta(minutes=5)

        message = f"Rate limit reached for @{account['username']}. Rescheduled for {run_at.isoformat()} UTC."
        await self.db.accounts.update_one({"_id": account["_id"]}, {"$set": {"status": "LIMITED"}})
        await self.db.jobs.update_one(
            {"_id": ObjectId(job_id_str)},
            {"$set": {
                "status": "RETRYING",
                "scheduled_time": run_at,
                "error_message": message
            }}
        )
        await self.redis_client.zadd(SCHEDULED_QUEUE, {job_id_str: run_at.timestamp()})
        logger.warning(message)

    async def postpone_for_account_cooldown(self, job_id_str: str, job: dict, account: dict, run_at: datetime):
        message = (
            f"Waiting for @{account['username']} cooldown. "
            f"Rescheduled for {run_at.isoformat()} UTC."
        )
        await self.db.jobs.update_one(
            {"_id": ObjectId(job_id_str)},
            {"$set": {
                "status": "RETRYING",
                "scheduled_time": run_at,
                "error_message": message
            }}
        )
        await self.redis_client.zadd(SCHEDULED_QUEUE, {job_id_str: run_at.timestamp()})
        logger.info(message)

    async def enqueue_due_scheduled_jobs(self):
        now_ts = datetime.utcnow().timestamp()
        job_ids = await self.redis_client.zrangebyscore(SCHEDULED_QUEUE, 0, now_ts, start=0, num=100)
        due_from_db = await self.db.jobs.find({
            "status": "RETRYING",
            "scheduled_time": {"$lte": datetime.utcnow()}
        }, {"_id": 1}).to_list(length=100)
        db_job_ids = [str(job["_id"]) for job in due_from_db]
        job_ids = list(dict.fromkeys([*job_ids, *db_job_ids]))
        if not job_ids:
            return

        await self.redis_client.zrem(SCHEDULED_QUEUE, *job_ids)
        for job_id_str in job_ids:
            if not ObjectId.is_valid(job_id_str):
                continue

            job = await self.db.jobs.find_one({"_id": ObjectId(job_id_str)})
            if not job or job.get("status") != "RETRYING":
                continue

            campaign = await self.db.campaigns.find_one({"_id": job["campaign_id"]})
            if not campaign:
                await self.db.jobs.update_one({"_id": job["_id"]}, {"$set": {"status": "CANCELLED"}})
                continue
            if campaign["status"] == "PAUSED":
                await self.db.jobs.update_one({"_id": job["_id"]}, {"$set": {"status": "PENDING"}})
                continue
            if campaign["status"] != "RUNNING":
                await self.db.jobs.update_one({"_id": job["_id"]}, {"$set": {"status": "CANCELLED"}})
                continue

            await self.db.jobs.update_one(
                {"_id": job["_id"], "status": "RETRYING"},
                {"$set": {"status": "QUEUED"}}
            )
            await self.redis_client.rpush(IMMEDIATE_QUEUE, job_id_str)
            logger.info(f"Moved due scheduled job {job_id_str} back to the immediate queue")

    async def handle_permanent_account_error(self, job_id_str: str, job: dict, account: dict, error_msg: str):
        """Fail unrecoverable account/session errors without retrying the same bad cookie."""
        db = self.db
        now = datetime.utcnow()
        logger.error(f"Job {job_id_str} failed with permanent account error: {error_msg}")

        await db.jobs.update_one(
            {"_id": ObjectId(job_id_str)},
            {"$set": {
                "status": "FAILED",
                "completed_at": now,
                "error_message": error_msg
            }}
        )

        await db.target_urls.update_one(
            {"_id": job["url_id"]},
            {"$set": {
                "status": "FAILED",
                "processed_at": now,
                "error_message": error_msg
            }}
        )

        await db.accounts.update_one(
            {"_id": account["_id"]},
            {"$set": {
                "status": "ERROR",
                "health_score": max(0, account.get("health_score", 100) - 20)
            }}
        )

    async def refresh_target_url_status_from_jobs(self, url_id):
        jobs = await self.db.jobs.find({"url_id": url_id}).sort("created_at", -1).to_list(length=1000)
        if not jobs:
            return

        active_statuses = ["PENDING", "QUEUED", "RUNNING", "RETRYING"]
        now = datetime.utcnow()
        active_job = next((job for job in jobs if job.get("status") in active_statuses), None)
        latest_job = jobs[0]

        if active_job:
            next_status = "PROCESSING"
            processed_at = None
            error_message = None
        elif latest_job.get("status") == "FAILED":
            next_status = "FAILED"
            processed_at = now
            error_message = latest_job.get("error_message")
        elif latest_job.get("status") == "CANCELLED":
            next_status = "SKIPPED"
            processed_at = now
            error_message = latest_job.get("error_message") or "Job was cancelled."
        elif latest_job.get("status") == "SUCCESS":
            next_status = "SUCCESS"
            processed_at = now
            error_message = None
        else:
            return

        await self.db.target_urls.update_one(
            {"_id": url_id},
            {"$set": {
                "status": next_status,
                "processed_at": processed_at,
                "error_message": error_message
            }}
        )

    async def check_campaign_completion(self, campaign_id):
        # Count remaining running/queued/pending jobs in this campaign
        remaining = await self.db.jobs.count_documents({
            "campaign_id": campaign_id,
            "status": {"$in": ["PENDING", "QUEUED", "RUNNING", "RETRYING"]}
        })

        if remaining == 0:
            campaign = await self.db.campaigns.find_one({"_id": campaign_id})
            if campaign and campaign.get("campaign_type") == "MONITOR":
                logger.info(f"All current jobs for monitored campaign {campaign_id} completed. Keeping campaign RUNNING for future scans.")
                return
            # Facebook publish campaigns run indefinitely until stopped manually
            if campaign and campaign.get("platform") == "Facebook":
                return

            logger.info(f"All jobs for campaign {campaign_id} completed. Finalizing campaign status...")
            failed = await self.db.jobs.count_documents({
                "campaign_id": campaign_id,
                "status": "FAILED"
            })
            next_status = "FAILED" if failed else "COMPLETED"
            update_fields = {
                "status": next_status,
                "end_time": datetime.utcnow()
            }
            if campaign and campaign.get("repeat_enabled"):
                schedule_mode = campaign.get("schedule_mode")
                if schedule_mode == "fixed_times" and campaign.get("schedule_fixed_times"):
                    update_fields["next_run_at"] = compute_next_fixed_time(campaign["schedule_fixed_times"])
                elif campaign.get("repeat_interval_minutes"):
                    update_fields["next_run_at"] = datetime.utcnow() + timedelta(
                        minutes=campaign.get("repeat_interval_minutes", 60)
                    )

            await self.db.campaigns.update_one(
                {"_id": campaign_id, "status": "RUNNING"},
                {"$set": update_fields}
            )

    async def process_job(self, job_id_str: str):
        if not ObjectId.is_valid(job_id_str):
            logger.error(f"Invalid job ID received from queue: {job_id_str}")
            return

        db = self.db
        job = await db.jobs.find_one({"_id": ObjectId(job_id_str)})
        
        if not job:
            logger.error(f"Job {job_id_str} not found in database.")
            return
            
        # If campaign is paused or stopped, job might be set to PENDING/CANCELLED. Skip processing.
        if job["status"] not in ["QUEUED", "RUNNING"]:
            logger.warning(f"Skipping job {job_id_str} since it is in status {job['status']}")
            return

        campaign_id = job["campaign_id"]
        # Double check campaign status
        campaign = await db.campaigns.find_one({"_id": campaign_id})
        if not campaign or campaign["status"] != "RUNNING":
            logger.warning(f"Skipping job {job_id_str} since campaign status is {campaign.get('status') if campaign else 'DELETED'}")
            # Reset job status to PENDING or CANCELLED
            new_status = "PENDING" if campaign and campaign["status"] == "PAUSED" else "CANCELLED"
            await db.jobs.update_one({"_id": job["_id"]}, {"$set": {"status": new_status}})
            if campaign and campaign["status"] == "PAUSED":
                await db.target_urls.update_one(
                    {"_id": job["url_id"]},
                    {"$set": {"status": "PENDING", "error_message": None}}
                )
            return

        account_id = job["account_id"]
        account = await db.accounts.find_one({"_id": account_id})
        if not account:
            await self.handle_retry(job_id_str, job, "Social account not found.")
            await self.check_campaign_completion(campaign_id)
            return
            
        # Check limit resets (hourly/daily)
        account = await self.check_and_reset_limits(account)
        
        # Verify account status
        if account["status"] not in ["ACTIVE", "LIMITED"]:
            # If account is disabled/error, retry or fail the job
            await self.handle_retry(job_id_str, job, f"Account @{account['username']} is {account['status']}")
            await self.check_campaign_completion(campaign_id)
            return

        # Check rate limits
        if account["hourly_usage_count"] >= account["hourly_limit"] or account["daily_usage_count"] >= account["daily_limit"]:
            logger.warning(f"Account @{account['username']} hit rate limits. Hourly: {account['hourly_usage_count']}/{account['hourly_limit']}, Daily: {account['daily_usage_count']}/{account['daily_limit']}")
            
            await self.postpone_for_rate_limit(job_id_str, job, account)
            await self.check_campaign_completion(campaign_id)
            return

        if campaign["platform"] == "Threads":
            last_activity = parse_to_naive_utc(account.get("last_activity"))
            if last_activity:
                cooldown_secs = random.randint(ACCOUNT_COMMENT_COOLDOWN_MIN_SECONDS, ACCOUNT_COMMENT_COOLDOWN_MAX_SECONDS)
                cooldown_until = last_activity + timedelta(seconds=cooldown_secs)
                if datetime.utcnow() < cooldown_until:
                    await self.postpone_for_account_cooldown(job_id_str, job, account, cooldown_until)
                    await self.check_campaign_completion(campaign_id)
                    return
        elif campaign["platform"] == "X":
            last_activity = parse_to_naive_utc(account.get("last_activity"))
            if last_activity:
                gap_secs = random.randint(X_MIN_GAP_SECONDS, X_MAX_GAP_SECONDS)
                cooldown_until = last_activity + timedelta(seconds=gap_secs)
                if datetime.utcnow() < cooldown_until:
                    await self.postpone_for_account_cooldown(job_id_str, job, account, cooldown_until)
                    await self.check_campaign_completion(campaign_id)
                    return

        # Start execution
        await db.jobs.update_one(
            {"_id": ObjectId(job_id_str)},
            {"$set": {
                "status": "RUNNING",
                "started_at": datetime.utcnow()
            }}
        )

        url_doc = await db.target_urls.find_one({"_id": job["url_id"]})
        template_doc = await db.comment_templates.find_one({"_id": job["template_id"]})

        if not url_doc or not template_doc:
            error_details = f"Missing Target URL (found: {url_doc is not None}) or Comment Template (found: {template_doc is not None})"
            await self.handle_retry(job_id_str, job, error_details)
            await self.check_campaign_completion(campaign_id)
            return

        cookies = parse_cookie_to_dict(account.get("cookie"))
        if campaign["platform"] == "X":
            missing = [key for key in ["auth_token", "ct0"] if not cookies.get(key)]
        elif campaign["platform"] == "Threads":
            has_official_token = bool(account.get("access_token") and account.get("threads_user_id"))
            has_cookie = bool(cookies.get("sessionid") or cookies.get("session_id"))
            missing = [] if has_official_token or has_cookie else ["official access_token + threads_user_id or sessionid/session_id"]
        elif campaign["platform"] == "Facebook":
            missing = [] if account.get("access_token") else ["page_access_token"]
        else:
            missing = [f"unsupported platform {campaign['platform']}"]

        if missing:
            await self.handle_retry(
                job_id_str,
                job,
                f"Account @{account['username']} is missing required credentials: {', '.join(missing)}"
            )
            await self.check_campaign_completion(campaign_id)
            return

        try:
            # Spin the comment text if it contains spintax (e.g. {Hello|Hi} world!)
            comment_text = spin_spintax(template_doc["content"])

            if campaign["platform"] == "Facebook":
                post_id = extract_fb_post_id(url_doc["url"])
                result = await post_comment_facebook(
                    page_access_token=account["access_token"],
                    post_id=post_id,
                    comment_text=comment_text,
                    proxy=account.get("proxy"),
                )
            else:
                result = await mock_post_comment(
                    platform=campaign["platform"],
                    username=account["username"],
                    target_url=url_doc["url"],
                    comment_content=comment_text,
                    cookie=account.get("cookie"),
                    proxy=account.get("proxy"),
                    access_token=account.get("access_token"),
                    threads_user_id=account.get("threads_user_id"),
                )

            latest_campaign = await db.campaigns.find_one({"_id": campaign_id})
            latest_job = await db.jobs.find_one({"_id": ObjectId(job_id_str)})
            if not latest_campaign or latest_campaign["status"] != "RUNNING" or latest_job.get("status") == "CANCELLED":
                now = datetime.utcnow()
                await db.jobs.update_one(
                    {"_id": ObjectId(job_id_str), "status": {"$ne": "SUCCESS"}},
                    {"$set": {
                        "status": "CANCELLED",
                        "completed_at": now,
                        "error_message": "Campaign stopped before the worker could finalize the job."
                    }}
                )
                await db.target_urls.update_one(
                    {"_id": url_doc["_id"], "status": {"$ne": "SUCCESS"}},
                    {"$set": {
                        "status": "SKIPPED",
                        "processed_at": now,
                        "error_message": "Campaign stopped by user"
                    }}
                )
                await self.check_campaign_completion(campaign_id)
                return
            
            # Success!
            now = datetime.utcnow()
            await db.jobs.update_one(
                {"_id": ObjectId(job_id_str)},
                {"$set": {
                    "status": "SUCCESS",
                    "completed_at": now,
                    "error_message": None,
                    "real_api": result.get("real_api", False),
                    "commented_text": comment_text
                }}
            )
            
            await self.refresh_target_url_status_from_jobs(url_doc["_id"])
            
            # Update account usage counters and activity time
            await db.accounts.update_one(
                {"_id": account["_id"]},
                {
                    "$inc": {"hourly_usage_count": 1, "daily_usage_count": 1},
                    "$set": {"last_activity": now}
                }
            )
            logger.info(f"Job {job_id_str} processed successfully!")
            
        except (SocialAuthError, SocialCheckpointError) as e:
            await self.handle_permanent_account_error(job_id_str, job, account, str(e))
        except Exception as e:
            # Handle transient service errors with retry/backoff.
            await self.handle_retry(job_id_str, job, str(e))
            
        # Check if campaign has finished
        await self.check_campaign_completion(campaign_id)

    async def monitor_campaign_fetch_and_enqueue(self, campaign):
        db = self.db
        campaign_id = campaign["_id"]
        platform = campaign["platform"]
        page_urls = normalize_monitor_page_urls(campaign)
        if not page_urls:
            return

        # Fetch active accounts
        accounts_query = {
            "platform": platform,
            "status": "ACTIVE",
            "owner_id": campaign["owner_id"]
        }
        accounts = await db.accounts.find(accounts_query).sort("_id", 1).to_list(length=100)
        
        # Filter valid accounts (with cookies)
        from app.services.social_mock import parse_cookie_to_dict
        valid_accounts = []
        for account in accounts:
            cookies = parse_cookie_to_dict(account.get("cookie"))
            if platform == "X":
                valid = bool(cookies.get("auth_token") and cookies.get("ct0"))
            elif platform == "Facebook":
                valid = bool(account.get("access_token"))
            else:
                valid = bool(
                    account.get("access_token") and account.get("threads_user_id")
                ) or bool(cookies.get("sessionid") or cookies.get("session_id"))
            if valid:
                valid_accounts.append(account)

        if not valid_accounts:
            logger.error(f"Cannot monitor campaign '{campaign['name']}': No active accounts with valid credentials.")
            return

        active_campaign_jobs = await db.jobs.count_documents({
            "campaign_id": campaign_id,
            "status": {"$in": ["PENDING", "QUEUED", "RUNNING", "RETRYING"]},
        })
        if active_campaign_jobs:
            logger.info(
                f"Monitored campaign '{campaign['name']}' still has {active_campaign_jobs} active jobs. "
                "Waiting before adding another comment round."
            )
            return

        # Get all existing target URLs for this campaign
        existing_url_docs = await db.target_urls.find(
            {"campaign_id": campaign_id},
            {"url": 1, "monitor_source_url": 1}
        ).to_list(length=1000)
        existing_urls = [doc["url"] for doc in existing_url_docs]
        existing_url_set = set(existing_urls)
        
        # Fetch templates
        templates = await db.comment_templates.find(
            {"campaign_id": campaign_id, "status": "ACTIVE"}
        ).sort("created_at", 1).to_list(length=100)
        if not templates:
            logger.error(f"Cannot process new posts for campaign '{campaign['name']}': No active comment templates.")
            return

        from app.services.social_mock import mock_fetch_latest_post

        # Load-Balanced Account tracking: counts active jobs for each account
        assigned_counts = {str(acc["_id"]): 0 for acc in valid_accounts}
        active_jobs = await db.jobs.find({
            "status": {"$in": ["QUEUED", "RUNNING", "RETRYING"]}
        }).to_list(length=1000)
        for j in active_jobs:
            acc_id_str = str(j["account_id"])
            if acc_id_str in assigned_counts:
                assigned_counts[acc_id_str] += 1

        # For Threads, pre-calculate per-account cooldown spacing so newly created
        # jobs aren't queued immediately and then reactively rescheduled by the
        # worker for hitting the inter-comment cooldown.
        now = datetime.utcnow()
        cooldown_tracker = build_account_cooldown_tracker(valid_accounts, active_jobs, now, platform=platform)

        # Concurrent Polling with Semaphore & Account Rotation (Option 2)
        MAX_CONCURRENT_MONITOR_SCANS = 10
        sem = asyncio.Semaphore(MAX_CONCURRENT_MONITOR_SCANS)

        async def fetch_latest_for_url(page_index, page_url):
            async with sem:
                source_existing_urls = [
                    doc["url"]
                    for doc in existing_url_docs
                    if doc.get("monitor_source_url") == page_url
                ]
                # Rotate account used for cào to distribute the requests across all valid accounts
                scraper_account = valid_accounts[page_index % len(valid_accounts)]
                try:
                    latest_post = await mock_fetch_latest_post(
                        platform,
                        page_url,
                        source_existing_urls,
                        cookie_str=scraper_account.get("cookie"),
                        proxy=scraper_account.get("proxy"),
                        allow_real_fallback=False,
                    )
                    return page_url, latest_post
                except Exception as e:
                    logger.warning(f"Cannot fetch latest post for monitored source {page_url}: {e}")
                    return page_url, None

        # Execute all scans concurrently
        tasks = [fetch_latest_for_url(idx, url) for idx, url in enumerate(page_urls)]
        scan_results = await asyncio.gather(*tasks)

        new_targets = []
        scheduled_url_ids = set()

        for page_url, latest_post in scan_results:
            if not latest_post:
                logger.info(f"No latest post found or error occurred for monitored source {page_url}")
                continue

            url_doc = next(
                (
                    doc
                    for doc in existing_url_docs
                    if doc.get("url") == latest_post
                ),
                None
            )

            if url_doc:
                url_id_str = str(url_doc["_id"])
                if url_id_str in scheduled_url_ids:
                    logger.info(
                        f"Latest post {latest_post} was already scheduled in this monitor cycle. "
                        f"Skipping duplicate source {page_url}."
                    )
                    continue

                active_for_url = await db.jobs.count_documents({
                    "campaign_id": campaign_id,
                    "url_id": url_doc["_id"],
                    "status": {"$in": ["PENDING", "QUEUED", "RUNNING", "RETRYING"]},
                })
                if active_for_url:
                    logger.info(
                        f"Latest post for monitored campaign '{campaign['name']}' still has active jobs. "
                        f"Waiting before adding more comments: {latest_post}"
                    )
                    continue

                logger.info(
                    f"Latest post already exists for monitored campaign '{campaign['name']}' from {page_url}. "
                    f"Adding another comment round: {latest_post}"
                )
                await db.target_urls.update_one(
                    {"_id": url_doc["_id"]},
                    {"$set": {"status": "PROCESSING", "error_message": None, "processed_at": None}}
                )
            else:
                logger.info(f"Found latest post for monitored campaign '{campaign['name']}' from {page_url}: {latest_post}. Processing...")

                url_doc = {
                    "campaign_id": campaign_id,
                    "url": latest_post,
                    "platform": platform,
                    "status": "PROCESSING",
                    "monitor_source_url": page_url,
                    "processed_at": None,
                    "error_message": None,
                    "created_at": datetime.utcnow()
                }
                result_url = await db.target_urls.insert_one(url_doc)
                url_doc["_id"] = result_url.inserted_id
                existing_url_set.add(latest_post)
                existing_url_docs.append({
                    "_id": url_doc["_id"],
                    "url": latest_post,
                    "monitor_source_url": page_url
                })

            new_targets.append(url_doc)
            scheduled_url_ids.add(str(url_doc["_id"]))

        jobs_enqueued = 0
        template_cursor = int(campaign.get("comment_template_cursor") or 0) % len(templates)
        for target_url in new_targets:
            template = templates[(template_cursor + jobs_enqueued) % len(templates)]

            # Select account using smart load balancing
            account = min(valid_accounts, key=lambda a: assigned_counts[str(a["_id"])])
            assigned_counts[str(account["_id"])] += 1

            scheduled_time, is_delayed = reserve_account_schedule(
                cooldown_tracker, str(account["_id"]), platform, now
            )

            job_doc = {
                "campaign_id": campaign_id,
                "account_id": account["_id"],
                "url_id": target_url["_id"],
                "template_id": template["_id"],
                "status": "RETRYING" if is_delayed else "QUEUED",
                "attempt_count": 0,
                "scheduled_time": scheduled_time,
                "started_at": None,
                "completed_at": None,
                "error_message": None,
                "created_at": datetime.utcnow()
            }
            result_job = await db.jobs.insert_one(job_doc)
            job_id_str = str(result_job.inserted_id)

            if is_delayed:
                await self.redis_client.zadd(SCHEDULED_QUEUE, {job_id_str: scheduled_time.timestamp()})
            else:
                await self.redis_client.rpush(IMMEDIATE_QUEUE, job_id_str)
            jobs_enqueued += 1
            logger.info(
                f"Enqueued job {job_id_str} for monitored post: {target_url['url']} "
                f"using template {template['_id']}"
            )

        if jobs_enqueued:
            await db.campaigns.update_one(
                {"_id": campaign_id},
                {"$set": {"comment_template_cursor": (template_cursor + jobs_enqueued) % len(templates)}}
            )

    async def check_monitored_campaigns(self):
        db = self.db
        now = datetime.utcnow()
        cursor = db.campaigns.find({
            "campaign_type": "MONITOR",
            "status": "RUNNING"
        })
        async for campaign in cursor:
            campaign_id = campaign["_id"]
            interval_mins = campaign.get("monitor_interval", 15)
            last_monitored = campaign.get("last_monitored_at")
            last_monitored = parse_to_naive_utc(last_monitored)
            
            should_check = False
            if not last_monitored:
                should_check = True
            else:
                if now - last_monitored >= timedelta(minutes=interval_mins):
                    should_check = True
            
            if should_check:
                logger.info(f"Checking monitored page for campaign '{campaign['name']}' ({campaign_id})")
                try:
                    await self.monitor_campaign_fetch_and_enqueue(campaign)
                except Exception as e:
                    logger.error(f"Error monitoring campaign {campaign_id}: {e}")
                
                # Update last_monitored_at
                await db.campaigns.update_one(
                    {"_id": campaign_id},
                    {"$set": {"last_monitored_at": datetime.utcnow()}}
                )

    async def postpone_recurring_campaign(self, campaign, reason: str):
        schedule_mode = campaign.get("schedule_mode")
        if schedule_mode == "fixed_times" and campaign.get("schedule_fixed_times"):
            next_run_at = compute_next_fixed_time(campaign["schedule_fixed_times"])
        else:
            interval_mins = campaign.get("repeat_interval_minutes") or 60
            next_run_at = datetime.utcnow() + timedelta(minutes=interval_mins)
        await self.db.campaigns.update_one(
            {"_id": campaign["_id"]},
            {"$set": {
                "status": "FAILED",
                "end_time": datetime.utcnow(),
                "next_run_at": next_run_at,
            }}
        )
        logger.error(
            f"Recurring campaign '{campaign.get('name')}' could not start: {reason}. "
            f"Next attempt at {next_run_at.isoformat()} UTC."
        )

    async def start_recurring_campaign(self, campaign):
        db = self.db
        campaign_id = campaign["_id"]
        platform = campaign["platform"]

        active_jobs = await db.jobs.count_documents({
            "campaign_id": campaign_id,
            "status": {"$in": ["PENDING", "QUEUED", "RUNNING", "RETRYING"]}
        })
        if active_jobs:
            logger.info(f"Recurring campaign '{campaign['name']}' still has active jobs. Skipping this tick.")
            return

        target_urls = await db.target_urls.find({"campaign_id": campaign_id}).sort("created_at", 1).to_list(length=1000)
        if not target_urls:
            await self.postpone_recurring_campaign(campaign, "No target URLs configured")
            return

        templates = await db.comment_templates.find({
            "campaign_id": campaign_id,
            "status": "ACTIVE",
        }).sort("created_at", 1).to_list(length=100)
        if not templates:
            await self.postpone_recurring_campaign(campaign, "No active comment templates configured")
            return

        if platform == "Facebook":
            fb_account_id = campaign.get("facebook_account_id")
            if fb_account_id and ObjectId.is_valid(fb_account_id):
                fb_acc = await db.accounts.find_one({"_id": ObjectId(fb_account_id), "status": "ACTIVE"})
                valid_accounts = [fb_acc] if fb_acc and fb_acc.get("access_token") else []
            else:
                all_fb = await db.accounts.find({
                    "platform": "Facebook", "status": "ACTIVE", "owner_id": campaign["owner_id"]
                }).to_list(length=10)
                valid_accounts = [a for a in all_fb if a.get("access_token")]
        else:
            accounts = await db.accounts.find({
                "platform": platform,
                "status": "ACTIVE",
                "owner_id": campaign["owner_id"],
            }).sort("_id", 1).to_list(length=100)

            valid_accounts = []
            for account in accounts:
                cookies = parse_cookie_to_dict(account.get("cookie"))
                if platform == "X":
                    valid = bool(cookies.get("auth_token") and cookies.get("ct0"))
                else:
                    valid = bool(
                        account.get("access_token") and account.get("threads_user_id")
                    ) or bool(cookies.get("sessionid") or cookies.get("session_id"))
                if valid:
                    valid_accounts.append(account)

        if not valid_accounts:
            await self.postpone_recurring_campaign(campaign, "No active accounts with valid credentials")
            return

        lock_result = await db.campaigns.update_one(
            {
                "_id": campaign_id,
                "repeat_enabled": True,
                "campaign_type": {"$ne": "MONITOR"},
                "status": {"$in": ["READY", "COMPLETED", "FAILED"]},
                "next_run_at": {"$lte": datetime.utcnow()},
            },
            {"$set": {
                "status": "RUNNING",
                "start_time": datetime.utcnow(),
                "end_time": None,
                "next_run_at": None,
                "last_repeat_run_at": datetime.utcnow(),
            }}
        )
        if lock_result.modified_count != 1:
            return

        assigned_counts = {str(acc["_id"]): 0 for acc in valid_accounts}
        active_jobs_global = await db.jobs.find({
            "status": {"$in": ["QUEUED", "RUNNING", "RETRYING"]}
        }).to_list(length=1000)
        for job in active_jobs_global:
            acc_id_str = str(job["account_id"])
            if acc_id_str in assigned_counts:
                assigned_counts[acc_id_str] += 1

        # For Threads, pre-calculate per-account cooldown spacing so newly created
        # jobs aren't queued immediately and then reactively rescheduled by the
        # worker for hitting the inter-comment cooldown.
        now = datetime.utcnow()
        cooldown_tracker = build_account_cooldown_tracker(valid_accounts, active_jobs_global, now, platform=platform)

        jobs_enqueued = 0
        template_cursor = int(campaign.get("comment_template_cursor") or 0) % len(templates)
        for target_url in target_urls:
            template = templates[(template_cursor + jobs_enqueued) % len(templates)]
            assigned_id = target_url.get("assigned_account_id")
            account = None
            if assigned_id:
                account = next((a for a in valid_accounts if a["_id"] == assigned_id), None)
            if not account:
                account = min(valid_accounts, key=lambda a: assigned_counts[str(a["_id"])])

            assigned_counts[str(account["_id"])] += 1

            scheduled_time, is_delayed = reserve_account_schedule(
                cooldown_tracker, str(account["_id"]), platform, now
            )

            job_doc = {
                "campaign_id": campaign_id,
                "account_id": account["_id"],
                "url_id": target_url["_id"],
                "template_id": template["_id"],
                "status": "RETRYING" if is_delayed else "QUEUED",
                "attempt_count": 0,
                "scheduled_time": scheduled_time,
                "started_at": None,
                "completed_at": None,
                "error_message": None,
                "created_at": datetime.utcnow()
            }
            result = await db.jobs.insert_one(job_doc)
            job_id_str = str(result.inserted_id)
            await db.target_urls.update_one(
                {"_id": target_url["_id"]},
                {"$set": {"status": "PROCESSING", "error_message": None, "processed_at": None}}
            )
            if is_delayed:
                await self.redis_client.zadd(SCHEDULED_QUEUE, {job_id_str: scheduled_time.timestamp()})
            else:
                await self.redis_client.rpush(IMMEDIATE_QUEUE, job_id_str)
            jobs_enqueued += 1

        if jobs_enqueued:
            await db.campaigns.update_one(
                {"_id": campaign_id},
                {"$set": {"comment_template_cursor": (template_cursor + jobs_enqueued) % len(templates)}}
            )

        logger.info(f"Recurring campaign '{campaign['name']}' started. Enqueued {jobs_enqueued} jobs.")

    async def check_facebook_publish_campaigns(self):
        """Tick: publish the next post for any RUNNING Facebook campaigns whose next_run_at has passed."""
        db = self.db
        now = datetime.utcnow()
        cursor = db.campaigns.find({
            "platform": "Facebook",
            "status": "RUNNING",
            "next_run_at": {"$lte": now},
        })
        async for campaign in cursor:
            campaign_id = campaign["_id"]
            try:
                await self._do_facebook_publish(campaign)
            except Exception as e:
                logger.error(f"Error in Facebook publish tick for campaign {campaign_id}: {e}")

    async def _resolve_post_image(self, campaign: dict, account: dict, first_comment_text: Optional[str] = None):
        """Resolves the image bytes to attach to the Facebook POST itself,
        per the campaign's post_image_mode (FROM_POST / AI_GENERATED). Only called
        when the template has no manually-uploaded image of its own — UPLOAD mode
        means "use the per-post image as usual" and needs no dynamic resolution here.
        Never raises: falls back to no image so a misconfigured image source doesn't
        block the post itself from being published."""
        mode = campaign.get("post_image_mode") or "UPLOAD"
        if mode == "UPLOAD":
            return None, "image.jpg"
        try:
            if mode == "FROM_POST":
                source_url = extract_first_url(first_comment_text)
                if not source_url:
                    logger.warning(
                        f"[Facebook] post_image_mode=FROM_POST but no URL found in first_comment for campaign '{campaign.get('name')}' — posting without image."
                    )
                    return None, "image.jpg"
                data = await fetch_random_post_photo(
                    source_url, cookie=account.get("cookie"), proxy=account.get("proxy")
                )
                return data, "image.jpg"

            if mode == "AI_GENERATED":
                prompt = campaign.get("post_image_prompt")
                if not prompt:
                    logger.warning(
                        f"[Facebook] post_image_mode=AI_GENERATED but post_image_prompt is empty for campaign '{campaign.get('name')}' — posting without image."
                    )
                    return None, "image.jpg"
                owner = await self.db.users.find_one({"_id": campaign.get("owner_id")})
                user_api_key = (owner or {}).get("openai_api_key")
                if not user_api_key and not settings.OPENAI_API_KEY:
                    logger.warning(
                        f"[Facebook] post_image_mode=AI_GENERATED but no OpenAI API key configured (owner or server-wide) for campaign '{campaign.get('name')}' — posting without image."
                    )
                    return None, "image.jpg"
                data = await generate_ai_image(prompt, api_key=user_api_key)
                return data, "image.png"

            return None, "image.jpg"
        except Exception as e:
            logger.warning(f"[Facebook] Could not resolve post image (mode={mode}) for campaign '{campaign.get('name')}': {e}")
            return None, "image.jpg"

    async def _do_facebook_publish(self, campaign: dict):
        db = self.db
        campaign_id = campaign["_id"]

        # Get the Facebook account
        fb_account_id = campaign.get("facebook_account_id")
        if fb_account_id and ObjectId.is_valid(fb_account_id):
            account = await db.accounts.find_one({"_id": ObjectId(fb_account_id), "status": "ACTIVE"})
        else:
            account = await db.accounts.find_one({
                "platform": "Facebook", "status": "ACTIVE", "owner_id": campaign["owner_id"]
            })

        if not account or not account.get("access_token"):
            logger.error(f"Facebook campaign '{campaign.get('name')}': no valid account/token. Stopping campaign.")
            await db.campaigns.update_one(
                {"_id": campaign_id, "status": "RUNNING"},
                {"$set": {"status": "FAILED", "end_time": datetime.utcnow(),
                          "error_message": "No active Facebook account with Page Access Token."}}
            )
            return

        # Only pick templates that haven't been published yet
        unpublished = await db.comment_templates.find({
            "campaign_id": campaign_id, "status": "ACTIVE", "published_at": None
        }).sort("created_at", 1).to_list(length=200)

        if not unpublished:
            # Check if there are any active templates at all
            has_any = await db.comment_templates.count_documents({"campaign_id": campaign_id, "status": "ACTIVE"})
            if has_any:
                # All posts published → complete the campaign
                logger.info(f"[Facebook] Campaign '{campaign.get('name')}': all posts published. Marking COMPLETED.")
                await db.campaigns.update_one(
                    {"_id": campaign_id, "status": "RUNNING"},
                    {"$set": {"status": "COMPLETED", "end_time": datetime.utcnow(), "next_run_at": None}}
                )
            else:
                logger.error(f"[Facebook] Campaign '{campaign.get('name')}': no active templates.")
                await db.campaigns.update_one(
                    {"_id": campaign_id, "status": "RUNNING"},
                    {"$set": {"status": "FAILED", "end_time": datetime.utcnow(),
                              "error_message": "No active post templates."}}
                )
            return

        # Always publish the first unpublished template in order
        template = unpublished[0]

        # Structured template fields
        message = spin_spintax(template["content"])
        image_url, image_data, image_filename = resolve_stored_image_reference(template.get("image_url"))
        first_comment_raw = template.get("first_comment") or None
        first_comment = spin_spintax(first_comment_raw) if first_comment_raw else None
        comment_delay_minutes = int(template.get("comment_delay_minutes") or 0)

        # No manually-uploaded image on this post → resolve one dynamically per the
        # campaign's post_image_mode (FROM_POST / AI_GENERATED), if configured.
        if not image_url and not image_data:
            dyn_image_data, dyn_image_filename = await self._resolve_post_image(campaign, account, first_comment_raw)
            if dyn_image_data:
                image_data, image_filename = dyn_image_data, dyn_image_filename

        # Calculate next_run_at before publishing so we update it regardless of success/failure
        schedule_mode = campaign.get("schedule_mode")
        if schedule_mode == "fixed_times" and campaign.get("schedule_fixed_times"):
            next_run_at = compute_next_fixed_time(campaign["schedule_fixed_times"])
        else:
            interval_mins = campaign.get("repeat_interval_minutes") or 60
            next_run_at = datetime.utcnow() + timedelta(minutes=interval_mins)

        now = datetime.utcnow()
        job_doc = {
            "campaign_id": campaign_id,
            "account_id": account["_id"],
            "url_id": None,
            "template_id": template["_id"],
            "status": "RUNNING",
            "attempt_count": 1,
            "scheduled_time": now,
            "started_at": now,
            "completed_at": None,
            "error_message": None,
            "created_at": now,
            "job_type": "fb_publish",
            "fb_image_url": image_url,
            "fb_first_comment": first_comment,
            "fb_comment_delay_minutes": comment_delay_minutes,
        }
        result = await db.jobs.insert_one(job_doc)
        job_oid = result.inserted_id

        try:
            result_api = await publish_post_facebook(
                page_access_token=account["access_token"],
                message=message,
                image_url=image_url,
                image_data=image_data,
                image_filename=image_filename,
                proxy=account.get("proxy"),
            )
            post_id = result_api.get("post_id", "")

            comment_status = None
            comment_error = None
            fb_comment_at = None

            if first_comment and post_id:
                if comment_delay_minutes > 0:
                    # Schedule comment for later
                    fb_comment_at = now + timedelta(minutes=comment_delay_minutes)
                    comment_status = "PENDING"
                    logger.info(f"[Facebook] Post {post_id} published. Comment scheduled at {fb_comment_at.isoformat()} UTC")
                else:
                    # Post comment immediately (plain text — the image, if any, is on the post itself)
                    try:
                        await post_comment_facebook(
                            page_access_token=account["access_token"],
                            post_id=post_id,
                            comment_text=first_comment,
                            proxy=account.get("proxy"),
                        )
                        comment_status = "SUCCESS"
                        logger.info(f"[Facebook] Added first comment to post {post_id}")
                    except Exception as ce:
                        comment_status = "FAILED"
                        comment_error = str(ce)
                        logger.warning(f"[Facebook] Failed to add first comment to post {post_id}: {ce}")

            await db.jobs.update_one(
                {"_id": job_oid},
                {"$set": {
                    "status": "SUCCESS",
                    "completed_at": datetime.utcnow(),
                    "real_api": result_api.get("real_api", False),
                    "commented_text": message,
                    "fb_post_id": post_id,
                    "fb_comment_status": comment_status,
                    "fb_comment_error": comment_error,
                    "fb_comment_at": fb_comment_at,
                }}
            )
            logger.info(f"[Facebook] Published post for campaign '{campaign.get('name')}'. post_id={post_id}")

            # Only mark the template as published once it's actually live on Facebook —
            # marking it on failure too would make the UI show "✓ Đã đăng" for a post
            # that was never posted.
            await db.comment_templates.update_one(
                {"_id": template["_id"]},
                {"$set": {"published_at": now}}
            )
        except SocialAuthError as e:
            await db.jobs.update_one(
                {"_id": job_oid},
                {"$set": {"status": "FAILED", "completed_at": datetime.utcnow(), "error_message": str(e)}}
            )
            await db.accounts.update_one(
                {"_id": account["_id"]},
                {"$set": {"status": "ERROR", "error_message": str(e)}}
            )
            logger.error(f"[Facebook] Auth error for campaign '{campaign.get('name')}': {e}")
        except Exception as e:
            await db.jobs.update_one(
                {"_id": job_oid},
                {"$set": {"status": "FAILED", "completed_at": datetime.utcnow(), "error_message": str(e)}}
            )
            logger.error(f"[Facebook] Publish error for campaign '{campaign.get('name')}': {e}")

        # Schedule next publish slot (only if more unpublished templates remain).
        # If the publish above failed, the template is still unpublished, so this
        # naturally retries the same post on the next scheduled run.
        remaining = await db.comment_templates.count_documents({
            "campaign_id": campaign_id, "status": "ACTIVE", "published_at": None
        })
        if remaining > 0:
            await db.campaigns.update_one(
                {"_id": campaign_id, "status": "RUNNING"},
                {"$set": {"next_run_at": next_run_at, "last_repeat_run_at": now}}
            )
        else:
            # All posts published — complete campaign on next tick
            await db.campaigns.update_one(
                {"_id": campaign_id, "status": "RUNNING"},
                {"$set": {"next_run_at": None, "last_repeat_run_at": now}}
            )

    async def check_pending_fb_comments(self):
        """Post delayed first-comments on Facebook publish jobs whose fb_comment_at has passed."""
        db = self.db
        now = datetime.utcnow()
        cursor = db.jobs.find({
            "job_type": "fb_publish",
            "fb_comment_status": "PENDING",
            "fb_comment_at": {"$lte": now},
        })
        async for job in cursor:
            try:
                await self._do_delayed_fb_comment(job)
            except Exception as e:
                logger.error(f"Error posting delayed FB comment for job {job['_id']}: {e}")

    async def _do_delayed_fb_comment(self, job: dict):
        db = self.db
        post_id = job.get("fb_post_id")
        comment_text = job.get("fb_first_comment")
        if not post_id or not comment_text:
            await db.jobs.update_one(
                {"_id": job["_id"]},
                {"$set": {"fb_comment_status": "FAILED", "fb_comment_error": "Missing post_id or comment text"}}
            )
            return

        account = await db.accounts.find_one({"_id": job["account_id"]})
        if not account or not account.get("access_token"):
            await db.jobs.update_one(
                {"_id": job["_id"]},
                {"$set": {"fb_comment_status": "FAILED", "fb_comment_error": "Account or token not found"}}
            )
            return

        try:
            await post_comment_facebook(
                page_access_token=account["access_token"],
                post_id=post_id,
                comment_text=comment_text,
                proxy=account.get("proxy"),
            )
            await db.jobs.update_one(
                {"_id": job["_id"]},
                {"$set": {"fb_comment_status": "SUCCESS", "fb_comment_error": None}}
            )
            logger.info(f"[Facebook] Delayed comment posted on post {post_id}")
        except SocialAuthError as e:
            await db.jobs.update_one(
                {"_id": job["_id"]},
                {"$set": {"fb_comment_status": "FAILED", "fb_comment_error": str(e)}}
            )
        except Exception as e:
            await db.jobs.update_one(
                {"_id": job["_id"]},
                {"$set": {"fb_comment_status": "FAILED", "fb_comment_error": str(e)}}
            )
            logger.warning(f"[Facebook] Delayed comment failed for post {post_id}: {e}")

    async def check_recurring_campaigns(self):
        now = datetime.utcnow()
        cursor = self.db.campaigns.find({
            "repeat_enabled": True,
            "campaign_type": {"$ne": "MONITOR"},
            "status": {"$in": ["READY", "COMPLETED", "FAILED"]},
            "next_run_at": {"$lte": now},
        })
        async for campaign in cursor:
            try:
                await self.start_recurring_campaign(campaign)
            except Exception as e:
                logger.error(f"Error starting recurring campaign {campaign.get('_id')}: {e}")

    async def process_account_refresh(self, account_id_str: str):
        if not ObjectId.is_valid(account_id_str):
            logger.error(f"Invalid account ID in refresh queue: {account_id_str}")
            return

        async with self.refresh_sem:
            db = self.db
            account = await db.accounts.find_one({"_id": ObjectId(account_id_str)})
            if not account:
                logger.error(f"Account {account_id_str} not found in database for refresh.")
                return

            platform = account.get("platform")
            username = account.get("username", "")
            cookie_str = account.get("cookie")
            access_token = account.get("access_token")
            proxy = account.get("proxy")

            logger.info(f"Worker starting background refresh for @{username} ({platform})...")

            # 1. Threads with official access_token
            if platform == "Threads" and access_token and len(access_token) > 20 and not access_token.lower().startswith("mock"):
                from app.services.social_mock import refresh_threads_access_token
                try:
                    result = await refresh_threads_access_token(access_token, proxy=proxy)
                    new_token = result["access_token"]
                    await db.accounts.update_one(
                        {"_id": ObjectId(account_id_str)},
                        {"$set": {
                            "access_token": new_token,
                            "status": "ACTIVE",
                            "health_score": 100,
                            "error_message": None,
                        }}
                    )
                    logger.info(f"Worker successfully refreshed Threads token for @{username}.")
                except Exception as e:
                    logger.error(f"Worker failed to refresh Threads token for @{username}: {e}")
                    await db.accounts.update_one(
                        {"_id": ObjectId(account_id_str)},
                        {"$set": {
                            "status": "ERROR",
                            "error_message": f"Worker refresh error: {str(e)}",
                        }}
                    )
            # 2. Cookie-based accounts (X or Threads session cookie)
            elif cookie_str and len(cookie_str) > 20 and not cookie_str.lower().startswith("mock"):
                from app.services.social_mock import refresh_account_cookies, SocialAuthError
                try:
                    result = await refresh_account_cookies(
                        platform=platform,
                        cookie_str=cookie_str,
                        username=username,
                        proxy=proxy,
                    )
                    await db.accounts.update_one(
                        {"_id": ObjectId(account_id_str)},
                        {"$set": {
                            "cookie": result["new_cookie"],
                            "status": "ACTIVE",
                            "health_score": 100,
                            "error_message": None,
                        }}
                    )
                    logger.info(f"Worker successfully refreshed cookie for @{username} ({platform}).")
                except SocialAuthError as e:
                    await db.accounts.update_one(
                        {"_id": ObjectId(account_id_str)},
                        {"$set": {
                            "status": "ERROR",
                            "health_score": max(0, account.get("health_score", 100) - 30),
                            "error_message": str(e),
                        }}
                    )
                    logger.warning(f"Worker cookie refresh failed (expired/invalid) for @{username}: {e}")
                except Exception as e:
                    logger.error(f"Worker failed to refresh cookies for @{username}: {e}")
                    await db.accounts.update_one(
                        {"_id": ObjectId(account_id_str)},
                        {"$set": {
                            "status": "ERROR",
                            "error_message": f"Worker refresh error: {str(e)}",
                        }}
                    )
            else:
                # Fallback for empty/mock accounts
                await asyncio.sleep(2)
                await db.accounts.update_one(
                    {"_id": ObjectId(account_id_str)},
                    {"$set": {
                        "status": "ACTIVE",
                        "health_score": 100,
                        "error_message": None,
                    }}
                )
                logger.info(f"Worker simulated refresh for mock account @{username}.")

    async def run(self):
        await self.connect()
        await self.recover_interrupted_jobs()
        logger.info("Worker listening for campaign jobs...")
        
        while self.running:
            try:
                # Run monitoring check every 10 seconds
                now_ts = datetime.utcnow().timestamp()
                if now_ts - self.last_monitor_check >= 10:
                    self.last_monitor_check = now_ts
                    await self.check_monitored_campaigns()
                    await self.check_recurring_campaigns()
                    await self.check_facebook_publish_campaigns()
                    await self.check_pending_fb_comments()

                await self.enqueue_due_scheduled_jobs()
                # BLPOP block for 5 seconds waiting for next job ID or refresh task ID
                # Returns (queue_name, item)
                res = await self.redis_client.blpop([IMMEDIATE_QUEUE, REFRESH_QUEUE], timeout=5)
                if res:
                    queue_name, item_str = res
                    if queue_name == IMMEDIATE_QUEUE:
                        logger.info(f"Dequeued job {item_str} from {queue_name}")
                        await self.process_job(item_str)
                    elif queue_name == REFRESH_QUEUE:
                        logger.info(f"Dequeued account refresh task for ID {item_str} from {queue_name}")
                        asyncio.create_task(self.process_account_refresh(item_str))
            except Exception as e:
                logger.error(f"Exception in worker execution loop: {e}")
                await asyncio.sleep(2)

        # Close connections
        if self.mongo_client:
            self.mongo_client.close()
        if self.redis_client:
            await self.redis_client.close()


if __name__ == "__main__":
    worker = Worker()
    try:
        asyncio.run(worker.run())
    except KeyboardInterrupt:
        logger.info("Worker stopped by keyboard interrupt.")
