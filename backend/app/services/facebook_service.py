import os
import json
import uuid
import shutil
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.date import DateTrigger

from app.db.database import get_db

logger = logging.getLogger("app.facebook_service")

GRAPH_API = "https://graph.facebook.com/v19.0"
UPLOAD_DIR = os.environ.get("FB_UPLOAD_DIR", "/app/fb_uploads")
MISFIRE_GRACE = 86400  # 24h

os.makedirs(UPLOAD_DIR, exist_ok=True)

scheduler = AsyncIOScheduler()

ALLOWED_IMG_EXT = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
ALLOWED_VID_EXT = {'mp4', 'mov', 'm4v', 'webm', 'avi'}
ALLOWED_EXT = ALLOWED_IMG_EXT | ALLOWED_VID_EXT


def allowed_file(filename: str) -> bool:
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXT


def is_video_file(filename: str) -> bool:
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_VID_EXT


def _parse_dt(s: str) -> datetime:
    dt = datetime.fromisoformat(s.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ── Facebook HTTP helpers ─────────────────────────────────────────────────────

async def fb_get(endpoint: str, token: str, params: dict = None) -> dict:
    p = dict(params or {})
    p["access_token"] = token
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(f"{GRAPH_API}/{endpoint}", params=p)
        return r.json()


async def fb_post_form(endpoint: str, token: str, data: dict = None, files=None) -> dict:
    d = dict(data or {})
    d["access_token"] = token
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(f"{GRAPH_API}/{endpoint}", data=d, files=files)
        return r.json()


# ── MongoDB helpers ───────────────────────────────────────────────────────────

async def db_insert_job(owner_id: str, job_id: str, job_type: str, description: str,
                        page_name: str, scheduled_time: str, job_params: dict = None):
    db = get_db()
    await db.fb_scheduled_jobs.insert_one({
        "_id": job_id,
        "owner_id": owner_id,
        "type": job_type,
        "description": description,
        "page_name": page_name,
        "scheduled_time": scheduled_time,
        "status": "pending",
        "result": "",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "job_params": job_params or {},
    })


async def db_update_job(job_id: str, status: str, result: str = ""):
    db = get_db()
    await db.fb_scheduled_jobs.update_one(
        {"_id": job_id},
        {"$set": {"status": status, "result": result}}
    )


async def history_insert(owner_id: str, page_id: str, page_name: str, message: str,
                         post_id: str, post_url: str, image_count: int, was_scheduled: bool):
    db = get_db()
    await db.fb_post_history.insert_one({
        "_id": str(uuid.uuid4()),
        "owner_id": owner_id,
        "page_id": page_id,
        "page_name": page_name,
        "message": (message or "")[:500],
        "post_id": post_id,
        "post_url": post_url,
        "image_count": image_count,
        "posted_at": datetime.now(timezone.utc).isoformat(),
        "was_scheduled": was_scheduled,
    })


# ── Upload helpers ────────────────────────────────────────────────────────────

def save_images_for_job(images_data: list, job_id: str) -> Optional[str]:
    """Save (filename, bytes, content_type) list to disk; return folder path or None."""
    valid = [(fn, data, ct) for fn, data, ct in images_data if allowed_file(fn)]
    if not valid:
        return None
    folder = os.path.join(UPLOAD_DIR, "scheduled", job_id)
    os.makedirs(folder, exist_ok=True)
    for fn, data, ct in valid:
        with open(os.path.join(folder, fn), 'wb') as f:
            f.write(data)
    return folder


async def _upload_images_from_folder(page_id: str, token: str, folder: Optional[str]) -> list:
    ids = []
    if not folder or not os.path.exists(folder):
        return ids
    for fname in sorted(os.listdir(folder)):
        fpath = os.path.join(folder, fname)
        with open(fpath, 'rb') as f:
            file_bytes = f.read()
        r = await fb_post_form(
            f"{page_id}/photos", token,
            data={'published': 'false', 'temporary': 'true'},
            files={'source': (fname, file_bytes, 'image/jpeg')}
        )
        if 'id' in r:
            ids.append(r['id'])
    return ids


async def _upload_first_media_for_story(page_id: str, token: str, folder: Optional[str]):
    if not folder or not os.path.exists(folder):
        return None, None
    for fname in sorted(os.listdir(folder)):
        fpath = os.path.join(folder, fname)
        with open(fpath, 'rb') as f:
            file_bytes = f.read()
        if is_video_file(fname):
            r = await fb_post_form(
                f"{page_id}/videos", token,
                data={'published': 'false'},
                files={'source': (fname, file_bytes, 'video/mp4')}
            )
            if 'id' in r:
                return r['id'], 'video'
        elif allowed_file(fname):
            r = await fb_post_form(
                f"{page_id}/photos", token,
                data={'published': 'false'},
                files={'source': (fname, file_bytes, 'image/jpeg')}
            )
            if 'id' in r:
                return r['id'], 'photo'
    return None, None


# ── Immediate post helper ─────────────────────────────────────────────────────

async def post_to_page(token: str, page_id: str, message: str,
                       image_files_data: list, post_type: str = 'post') -> dict:
    if post_type == 'story':
        if not image_files_data:
            return {'error': 'Story cần ít nhất 1 ảnh hoặc video'}
        fname, data, ctype = image_files_data[0]
        if is_video_file(fname):
            r = await fb_post_form(f"{page_id}/videos", token,
                                   data={'published': 'false'},
                                   files={'source': (fname, data, ctype or 'video/mp4')})
            if 'error' in r:
                return {'error': r['error'].get('message', 'Lỗi upload video story')}
            if 'id' not in r:
                return {'error': 'Không lấy được video_id để đăng story'}
            result = await fb_post_form(f"{page_id}/video_stories", token, data={'video_id': r['id']})
        else:
            r = await fb_post_form(f"{page_id}/photos", token,
                                   data={'published': 'false'},
                                   files={'source': (fname, data, ctype or 'image/jpeg')})
            if 'error' in r:
                return {'error': r['error'].get('message', 'Lỗi upload ảnh story')}
            if 'id' not in r:
                return {'error': 'Không lấy được photo_id để đăng story'}
            result = await fb_post_form(f"{page_id}/photo_stories", token, data={'photo_id': r['id']})
        if 'error' in result:
            return {'error': result['error'].get('message', 'Lỗi đăng story')}
        story_id = result.get('id', '')
        return {'success': True, 'post_id': story_id, 'post_url': '', 'image_count': 1, 'is_story': True}

    photo_ids = []
    for fname, data, ctype in image_files_data:
        r = await fb_post_form(f"{page_id}/photos", token,
                               data={'published': 'false', 'temporary': 'true'},
                               files={'source': (fname, data, ctype)})
        if 'id' in r:
            photo_ids.append(r['id'])
        elif 'error' in r:
            return {'error': r['error'].get('message', 'Lỗi upload ảnh')}

    post_data = {'message': message}
    for i, pid in enumerate(photo_ids):
        post_data[f'attached_media[{i}]'] = json.dumps({'media_fbid': pid})

    result = await fb_post_form(f"{page_id}/feed", token, data=post_data)
    if 'error' in result:
        return {'error': result['error'].get('message', 'Lỗi đăng bài')}
    post_id = result.get('id', '')
    post_url = f"https://www.facebook.com/{post_id.replace('_', '/posts/')}" if '_' in post_id else ''
    return {'success': True, 'post_id': post_id, 'post_url': post_url, 'image_count': len(photo_ids)}


# ── APScheduler job functions ─────────────────────────────────────────────────

async def execute_post_job(owner_id: str, job_id: str, token: str, page_id: str,
                           page_name: str, message: str, image_folder: Optional[str],
                           auto_comment: Optional[dict], post_type: str = 'post'):
    await db_update_job(job_id, 'running')
    try:
        if post_type == 'story':
            media_id, media_type = await _upload_first_media_for_story(page_id, token, image_folder)
            if image_folder:
                shutil.rmtree(image_folder, ignore_errors=True)
            if not media_id:
                await db_update_job(job_id, 'failed', 'Story cần ít nhất 1 ảnh hoặc video')
                return
            if media_type == 'video':
                result = await fb_post_form(f"{page_id}/video_stories", token, data={'video_id': media_id})
            else:
                result = await fb_post_form(f"{page_id}/photo_stories", token, data={'photo_id': media_id})
            if 'error' in result:
                await db_update_job(job_id, 'failed', result['error'].get('message', ''))
                return
            story_id = result.get('id', '')
            await db_update_job(job_id, 'done', story_id)
            hist_label = '[Story video]' if media_type == 'video' else '[Story ảnh]'
            await history_insert(owner_id, page_id, page_name, hist_label, story_id, '', 1, True)

        else:
            photo_ids = await _upload_images_from_folder(page_id, token, image_folder)
            img_count = len(photo_ids)
            if image_folder:
                shutil.rmtree(image_folder, ignore_errors=True)

            post_data = {'message': message}
            for i, pid in enumerate(photo_ids):
                post_data[f'attached_media[{i}]'] = json.dumps({'media_fbid': pid})

            result = await fb_post_form(f"{page_id}/feed", token, data=post_data)
            if 'error' in result:
                await db_update_job(job_id, 'failed', result['error'].get('message', ''))
                if auto_comment:
                    await db_update_job(auto_comment['cjob_id'], 'cancelled', 'Bài đăng thất bại')
                return

            post_id = result.get('id', '')
            post_url = (
                f"https://www.facebook.com/{post_id.replace('_', '/posts/')}"
                if '_' in post_id else ''
            )
            await db_update_job(job_id, 'done', post_id)
            await history_insert(owner_id, page_id, page_name, message, post_id, post_url, img_count, True)

            if auto_comment and auto_comment.get('text') and post_id:
                cjob_id = auto_comment['cjob_id']
                run_at_s = auto_comment.get('run_at')
                if run_at_s:
                    run_at = _parse_dt(run_at_s)
                    scheduler.add_job(
                        execute_comment_job,
                        trigger=DateTrigger(run_date=run_at),
                        args=[owner_id, cjob_id, token, post_id, auto_comment['text']],
                        id=cjob_id, misfire_grace_time=MISFIRE_GRACE
                    )
                else:
                    await execute_comment_job(owner_id, cjob_id, token, post_id, auto_comment['text'])

    except Exception as exc:
        logger.error(f"[FB] execute_post_job {job_id} failed: {exc}")
        await db_update_job(job_id, 'failed', str(exc))
        if auto_comment and post_type != 'story':
            await db_update_job(auto_comment['cjob_id'], 'cancelled', 'Bài đăng thất bại')


async def execute_comment_job(owner_id: str, job_id: str, token: str, post_id: str, comment_text: str):
    await db_update_job(job_id, 'running')
    try:
        result = await fb_post_form(f"{post_id}/comments", token, data={'message': comment_text})
        if 'error' in result:
            await db_update_job(job_id, 'failed', result['error'].get('message', ''))
        else:
            await db_update_job(job_id, 'done', result.get('id', ''))
    except Exception as exc:
        logger.error(f"[FB] execute_comment_job {job_id} failed: {exc}")
        await db_update_job(job_id, 'failed', str(exc))


# ── Restore pending jobs on startup ──────────────────────────────────────────

async def restore_pending_jobs():
    db = get_db()
    now = datetime.now(timezone.utc)
    restored = cancelled = 0
    async for row in db.fb_scheduled_jobs.find({"status": "pending"}):
        job_id = row["_id"]
        try:
            run_at = _parse_dt(row["scheduled_time"])
            if run_at < now - timedelta(seconds=MISFIRE_GRACE):
                await db_update_job(job_id, 'cancelled', 'Đã quá thời gian chờ sau khi khởi động lại')
                cancelled += 1
                continue
            params = row.get("job_params") or {}
            if not params:
                await db_update_job(job_id, 'cancelled', 'Thiếu params — vui lòng đặt lịch lại')
                cancelled += 1
                continue
            owner = row.get("owner_id", "")
            if row["type"] == 'post':
                scheduler.add_job(
                    execute_post_job,
                    trigger=DateTrigger(run_date=run_at),
                    args=[owner, job_id,
                          params['token'], params['page_id'], params['page_name'],
                          params['message'], params.get('image_folder'),
                          params.get('auto_comment'), params.get('post_type', 'post')],
                    id=job_id, misfire_grace_time=MISFIRE_GRACE, replace_existing=True
                )
            elif row["type"] == 'comment':
                scheduler.add_job(
                    execute_comment_job,
                    trigger=DateTrigger(run_date=run_at),
                    args=[owner, job_id,
                          params['token'], params['post_id'], params['comment_text']],
                    id=job_id, misfire_grace_time=MISFIRE_GRACE, replace_existing=True
                )
            restored += 1
        except Exception as e:
            await db_update_job(job_id, 'cancelled', f'Lỗi khôi phục: {e}')
            cancelled += 1

    if restored or cancelled:
        logger.info(f"[FB Scheduler] Restored {restored} jobs, cancelled {cancelled} expired jobs")
