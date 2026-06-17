import json
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, File
from pydantic import BaseModel

from app.api.routes.auth import get_current_user
from app.db.database import get_db
from app.services.facebook_service import (
    MISFIRE_GRACE,
    allowed_file,
    is_video_file,
    fb_get,
    fb_post_form,
    db_insert_job,
    db_update_job,
    history_insert,
    post_to_page,
    save_images_for_job,
    execute_post_job,
    execute_comment_job,
    scheduler,
    _parse_dt,
)
from apscheduler.triggers.date import DateTrigger

router = APIRouter(prefix="/facebook", tags=["Facebook Publisher"])


# ── Pydantic request models ───────────────────────────────────────────────────

class TokenBody(BaseModel):
    token: str

class SavePageBody(BaseModel):
    page_id: str
    name: str
    access_token: str
    picture: str = ""

class CommentBody(BaseModel):
    token: str
    post_id: str
    comment: str

class ScheduleCommentBody(BaseModel):
    token: str
    post_id: str
    page_name: str = ""
    comment: str
    scheduled_time: str


# ── Saved pages ───────────────────────────────────────────────────────────────

@router.get("/saved-pages")
async def get_saved_pages(current_user: dict = Depends(get_current_user)):
    db = get_db()
    pages = await db.fb_pages.find(
        {"owner_id": current_user["id"]}
    ).sort("added_at", -1).to_list(length=500)
    for p in pages:
        p["_id"] = str(p["_id"]) if isinstance(p.get("_id"), ObjectId) else p.get("_id")
    return {"pages": pages}


@router.post("/saved-pages")
async def save_page(body: SavePageBody, current_user: dict = Depends(get_current_user)):
    if not body.page_id or not body.name or not body.access_token:
        raise HTTPException(status_code=400, detail="Thiếu thông tin page")
    db = get_db()
    await db.fb_pages.update_one(
        {"owner_id": current_user["id"], "page_id": body.page_id},
        {"$set": {
            "owner_id": current_user["id"],
            "page_id": body.page_id,
            "name": body.name,
            "access_token": body.access_token,
            "picture": body.picture,
            "added_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True
    )
    return {"success": True}


@router.delete("/saved-pages/{page_id}")
async def delete_saved_page(page_id: str, current_user: dict = Depends(get_current_user)):
    db = get_db()
    await db.fb_pages.delete_one({"owner_id": current_user["id"], "page_id": page_id})
    return {"success": True}


# ── Fetch pages from FB token ─────────────────────────────────────────────────

@router.post("/pages")
async def fetch_fb_pages(body: TokenBody, current_user: dict = Depends(get_current_user)):
    token = body.token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="Thiếu access token")
    result = await fb_get("me/accounts", token, {"fields": "id,name,picture,access_token"})
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"].get("message", "Token không hợp lệ"))
    pages = [
        {
            "id": p["id"],
            "name": p["name"],
            "access_token": p.get("access_token", token),
            "picture": p.get("picture", {}).get("data", {}).get("url", ""),
        }
        for p in result.get("data", [])
    ]
    return {"pages": pages}


# ── Check permissions ─────────────────────────────────────────────────────────

@router.post("/check-permissions")
async def check_permissions(body: TokenBody, current_user: dict = Depends(get_current_user)):
    token = body.token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="Thiếu token")
    result = await fb_get("me/permissions", token)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"].get("message", ""))
    granted = {p["permission"] for p in result.get("data", []) if p.get("status") == "granted"}
    required = ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "pages_manage_engagement"]
    return {"granted": list(granted), "missing": [p for p in required if p not in granted]}


# ── Immediate post to multiple pages ─────────────────────────────────────────

@router.post("/post")
async def post_multi(
    post_type: str = Form("post"),
    title: str = Form(""),
    content: str = Form(""),
    pages: str = Form("[]"),
    images: List[UploadFile] = File(default=[]),
    current_user: dict = Depends(get_current_user),
):
    message = f"{title.strip()}\n\n{content.strip()}".strip() if title.strip() else content.strip()
    if post_type != "story" and not message:
        raise HTTPException(status_code=400, detail="Cần nhập tiêu đề hoặc nội dung")

    try:
        page_list = json.loads(pages)
    except ValueError:
        raise HTTPException(status_code=400, detail="Dữ liệu pages không hợp lệ")
    if not page_list:
        raise HTTPException(status_code=400, detail="Chưa chọn page nào")

    image_files_data = []
    for img in images:
        if not img.filename or not allowed_file(img.filename):
            continue
        if post_type == "post" and is_video_file(img.filename):
            continue
        file_bytes = await img.read()
        image_files_data.append((img.filename, file_bytes, img.content_type or "image/jpeg"))

    if post_type == "story" and not image_files_data:
        raise HTTPException(status_code=400, detail="Story cần ít nhất 1 ảnh hoặc video")

    results = []
    for page in page_list:
        pid = page.get("page_id", "")
        pname = page.get("name", pid)
        token = page.get("access_token", "")
        if not pid or not token:
            results.append({"page_id": pid, "name": pname, "error": "Thiếu token"})
            continue
        res = await post_to_page(token, pid, message, list(image_files_data), post_type=post_type)
        results.append({"page_id": pid, "name": pname, **res})
        if res.get("success"):
            hist_msg = "[Story]" if post_type == "story" else message
            await history_insert(
                current_user["id"], pid, pname, hist_msg,
                res["post_id"], res.get("post_url", ""),
                res.get("image_count", 0), False
            )

    return {"results": results, "post_type": post_type}


# ── Immediate comment ─────────────────────────────────────────────────────────

@router.post("/comment")
async def add_comment(body: CommentBody, current_user: dict = Depends(get_current_user)):
    if not body.token or not body.post_id:
        raise HTTPException(status_code=400, detail="Thiếu token hoặc post_id")
    if not body.comment:
        raise HTTPException(status_code=400, detail="Nội dung comment không được để trống")
    result = await fb_post_form(f"{body.post_id}/comments", body.token, data={"message": body.comment})
    if "error" in result:
        err = result["error"]
        code = err.get("code")
        msg = err.get("message", "Lỗi khi comment")
        if code == 200:
            msg = "Thiếu quyền \"pages_manage_engagement\". Hãy lấy lại token với đủ 4 quyền."
        raise HTTPException(status_code=400, detail=msg)
    return {"success": True, "comment_id": result.get("id", "")}


# ── Schedule post to multiple pages ──────────────────────────────────────────

@router.post("/schedule/post")
async def schedule_post_multi(
    post_type: str = Form("post"),
    title: str = Form(""),
    content: str = Form(""),
    scheduled_time: str = Form(...),
    auto_comment_text: str = Form(""),
    auto_comment_time: str = Form(""),
    pages: str = Form("[]"),
    images: List[UploadFile] = File(default=[]),
    current_user: dict = Depends(get_current_user),
):
    message = f"{title.strip()}\n\n{content.strip()}".strip() if title.strip() else content.strip()
    if post_type != "story" and not message:
        raise HTTPException(status_code=400, detail="Cần nhập tiêu đề hoặc nội dung")

    try:
        page_list = json.loads(pages)
    except ValueError:
        raise HTTPException(status_code=400, detail="Dữ liệu pages không hợp lệ")
    if not page_list:
        raise HTTPException(status_code=400, detail="Chưa chọn page nào")

    try:
        run_at = _parse_dt(scheduled_time)
        if run_at <= datetime.now(timezone.utc):
            raise ValueError("Thời gian phải trong tương lai")
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e))

    if auto_comment_text and auto_comment_time:
        try:
            cmt_at = _parse_dt(auto_comment_time)
            if cmt_at <= run_at:
                raise HTTPException(
                    status_code=400,
                    detail="Thời gian comment phải sau thời gian đăng bài"
                )
        except HTTPException:
            raise
        except ValueError:
            raise HTTPException(status_code=400, detail="Định dạng thời gian comment không hợp lệ")

    image_files_data = []
    for img in images:
        if not img.filename or not allowed_file(img.filename):
            continue
        file_bytes = await img.read()
        image_files_data.append((img.filename, file_bytes, img.content_type or "image/jpeg"))

    has_media = bool(image_files_data)
    if post_type == "story" and not has_media:
        raise HTTPException(status_code=400, detail="Story cần ít nhất 1 ảnh hoặc video")

    owner_id = current_user["id"]
    job_ids = []

    for page in page_list:
        pid = page.get("page_id", "")
        pname = page.get("name", pid)
        token = page.get("access_token", "")
        if not pid or not token:
            continue

        job_id = str(uuid.uuid4())
        image_folder = save_images_for_job(image_files_data, job_id)

        auto_comment = None
        cjob_id = None
        if auto_comment_text and post_type != "story":
            cjob_id = str(uuid.uuid4())
            auto_comment = {
                "text": auto_comment_text,
                "run_at": auto_comment_time if auto_comment_time else None,
                "cjob_id": cjob_id,
            }

        params = {
            "token": token,
            "page_id": pid,
            "page_name": pname,
            "message": message,
            "image_folder": image_folder,
            "auto_comment": auto_comment,
            "post_type": post_type,
        }

        desc = (
            f'Đăng story lên "{pname}"' if post_type == "story"
            else f'Đăng bài lên "{pname}"'
        )

        scheduler.add_job(
            execute_post_job,
            trigger=DateTrigger(run_date=run_at),
            args=[owner_id, job_id, token, pid, pname, message, image_folder, auto_comment, post_type],
            id=job_id, misfire_grace_time=MISFIRE_GRACE,
        )
        await db_insert_job(owner_id, job_id, "post", desc, pname, run_at.isoformat(), params)

        if cjob_id:
            cmt_t = auto_comment_time if auto_comment_time else run_at.isoformat()
            cmt_params = {
                "token": token,
                "post_id": None,
                "comment_text": auto_comment_text,
            }
            await db_insert_job(
                owner_id, cjob_id, "comment",
                f'Auto-comment sau bài của "{pname}"',
                pname, cmt_t, cmt_params
            )

        job_ids.append(job_id)

    return {"success": True, "job_ids": job_ids, "count": len(job_ids)}


# ── Schedule comment ──────────────────────────────────────────────────────────

@router.post("/schedule/comment")
async def schedule_comment(body: ScheduleCommentBody, current_user: dict = Depends(get_current_user)):
    if not body.token or not body.post_id or not body.comment or not body.scheduled_time:
        raise HTTPException(status_code=400, detail="Thiếu thông tin bắt buộc")

    try:
        run_at = _parse_dt(body.scheduled_time)
        if run_at <= datetime.now(timezone.utc):
            raise ValueError("Thời gian phải trong tương lai")
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e))

    owner_id = current_user["id"]
    job_id = str(uuid.uuid4())
    params = {"token": body.token, "post_id": body.post_id, "comment_text": body.comment}

    scheduler.add_job(
        execute_comment_job,
        trigger=DateTrigger(run_date=run_at),
        args=[owner_id, job_id, body.token, body.post_id, body.comment],
        id=job_id, misfire_grace_time=MISFIRE_GRACE,
    )
    await db_insert_job(
        owner_id, job_id, "comment",
        f'Comment vào bài của "{body.page_name}"',
        body.page_name, run_at.isoformat(), params
    )
    return {"success": True, "job_id": job_id}


# ── List scheduled jobs ───────────────────────────────────────────────────────

@router.get("/schedules")
async def list_schedules(current_user: dict = Depends(get_current_user)):
    db = get_db()
    jobs = await db.fb_scheduled_jobs.find(
        {"owner_id": current_user["id"]}
    ).sort("scheduled_time", -1).to_list(length=500)

    db_update_tasks = []
    for job in jobs:
        job["id"] = job.pop("_id")
        job.pop("job_params", None)
        if job["status"] == "pending" and not scheduler.get_job(job["id"]):
            job["status"] = "cancelled"
            db_update_tasks.append(db_update_job(job["id"], "cancelled", "Không tìm thấy trong scheduler"))

    for task in db_update_tasks:
        await task

    return {"jobs": jobs}


# ── Cancel a scheduled job ────────────────────────────────────────────────────

@router.delete("/schedule/{job_id}")
async def cancel_schedule(job_id: str, current_user: dict = Depends(get_current_user)):
    db = get_db()
    job = await db.fb_scheduled_jobs.find_one({"_id": job_id, "owner_id": current_user["id"]})
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    try:
        scheduler.remove_job(job_id)
    except Exception:
        pass
    await db_update_job(job_id, "cancelled", "Đã hủy bởi người dùng")
    return {"success": True}


# ── Post history ──────────────────────────────────────────────────────────────

@router.get("/history")
async def get_post_history(current_user: dict = Depends(get_current_user)):
    db = get_db()
    history = await db.fb_post_history.find(
        {"owner_id": current_user["id"]}
    ).sort("posted_at", -1).limit(100).to_list(length=100)
    for h in history:
        h["id"] = h.pop("_id")
    return {"history": history}
