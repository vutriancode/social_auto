import logging
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api.routes import accounts, auth, campaigns, dashboard, jobs, media
from app.api.routes import facebook
from app.db.database import close_mongo_connection, connect_to_mongo
from app.seed import seed_data
from app.services.queue_service import queue_service
from app.services.facebook_service import scheduler as fb_scheduler, restore_pending_jobs

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("app.main")

UPLOAD_DIR = "/app/static/uploads"

@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    # Startup logic
    await connect_to_mongo()
    await queue_service.connect()
    await seed_data()
    fb_scheduler.start()
    await restore_pending_jobs()
    yield
    # Shutdown logic
    fb_scheduler.shutdown(wait=False)
    await close_mongo_connection()
    await queue_service.disconnect()

app = FastAPI(
    title="Auto Social API",
    description="Backend service for managing automated comment campaigns on X/Threads",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json"
)

# Set CORS - allow any host on the frontend's dev/prod ports (for localhost,
# LAN IPs, or a public IP without per-server config) plus the public tunnel
# domain serving the frontend.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routes first so exact matches take priority over the static mount
app.include_router(auth.router, prefix="/api")
app.include_router(accounts.router, prefix="/api")
app.include_router(campaigns.router, prefix="/api")
app.include_router(jobs.router, prefix="/api")
app.include_router(dashboard.router, prefix="/api")
app.include_router(facebook.router, prefix="/api")
app.include_router(media.router, prefix="/api")

# Mount static files AFTER routers — Starlette checks routes in order,
# so the exact POST /api/media/upload route is found before this prefix mount.
app.mount("/api/media", StaticFiles(directory=UPLOAD_DIR), name="uploads")

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    body = await request.body()
    logger.error("422 Validation error on %s %s | body: %s | errors: %s",
                 request.method, request.url.path, body.decode()[:500], exc.errors())
    return JSONResponse(status_code=422, content={"detail": exc.errors()})


@app.get("/")
def read_root():
    return {
        "status": "online",
        "service": "Auto Social API",
        "documentation": "/docs"
    }
