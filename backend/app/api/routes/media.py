import os
import uuid
from fastapi import APIRouter, Depends, File, UploadFile, HTTPException

from app.api.routes.auth import get_current_user

UPLOAD_DIR = "/app/static/uploads"
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
MAX_SIZE_MB = 10

router = APIRouter(prefix="/media", tags=["Media"])


@router.post("/upload")
async def upload_image(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
):
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail=f"Chỉ chấp nhận ảnh JPEG/PNG/GIF/WebP. Nhận được: {file.content_type}")

    data = await file.read()
    if len(data) > MAX_SIZE_MB * 1024 * 1024:
        raise HTTPException(status_code=400, detail=f"File quá lớn (tối đa {MAX_SIZE_MB}MB)")

    ext = (file.filename or "image.jpg").rsplit(".", 1)[-1].lower()
    if ext not in ("jpg", "jpeg", "png", "gif", "webp"):
        ext = "jpg"
    filename = f"{uuid.uuid4().hex}.{ext}"

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    with open(os.path.join(UPLOAD_DIR, filename), "wb") as f:
        f.write(data)

    return {"url": f"/api/media/{filename}", "filename": filename, "size": len(data)}
