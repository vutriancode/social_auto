from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field


class CampaignCreate(BaseModel):
    name: str = Field(..., min_length=3, max_length=100)
    platform: str = Field(..., pattern="^(X|Threads|Facebook)$")
    description: Optional[str] = ""
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    campaign_type: Optional[str] = Field("STATIC", pattern="^(STATIC|MONITOR)$")
    monitor_page_url: Optional[str] = None
    monitor_page_urls: Optional[List[str]] = None
    monitor_interval: Optional[int] = Field(15, ge=1)
    repeat_enabled: bool = False
    repeat_interval_minutes: Optional[int] = Field(None, ge=1)
    # Facebook-specific scheduling
    schedule_mode: Optional[str] = Field(None, pattern="^(interval|fixed_times)$")
    schedule_interval_hours: Optional[int] = Field(None, ge=1)
    schedule_interval_minutes: Optional[int] = Field(None, ge=1)
    schedule_fixed_times: Optional[List[str]] = None  # ["08:00", "12:00", "18:00"]
    facebook_account_id: Optional[str] = None  # ObjectId of the Facebook Page account
    # Image attached to the Facebook post itself (used when a post has no manually-uploaded image)
    post_image_mode: Optional[str] = Field("UPLOAD", pattern="^(UPLOAD|FROM_POST|AI_GENERATED)$")
    post_image_prompt: Optional[str] = None


class CampaignUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = Field(None, pattern="^(DRAFT|READY|RUNNING|PAUSED|COMPLETED|FAILED|STOPPED|ARCHIVED)$")
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    campaign_type: Optional[str] = Field(None, pattern="^(STATIC|MONITOR)$")
    monitor_page_url: Optional[str] = None
    monitor_page_urls: Optional[List[str]] = None
    monitor_interval: Optional[int] = Field(None, ge=1)
    repeat_enabled: Optional[bool] = None
    repeat_interval_minutes: Optional[int] = Field(None, ge=1)
    schedule_mode: Optional[str] = Field(None, pattern="^(interval|fixed_times)$")
    schedule_interval_hours: Optional[int] = Field(None, ge=1)
    schedule_interval_minutes: Optional[int] = Field(None, ge=1)
    schedule_fixed_times: Optional[List[str]] = None
    facebook_account_id: Optional[str] = None
    next_run_at: Optional[datetime] = None
    post_image_mode: Optional[str] = Field(None, pattern="^(UPLOAD|FROM_POST|AI_GENERATED)$")
    post_image_prompt: Optional[str] = None


class CampaignOut(BaseModel):
    id: str
    name: str
    platform: str
    description: str
    status: str
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    created_by: str
    created_at: str
    campaign_type: str = "STATIC"
    monitor_page_url: Optional[str] = None
    monitor_page_urls: List[str] = Field(default_factory=list)
    monitor_interval: Optional[int] = 15
    last_monitored_at: Optional[str] = None
    repeat_enabled: bool = False
    repeat_interval_minutes: Optional[int] = None
    next_run_at: Optional[str] = None
    last_repeat_run_at: Optional[str] = None
    schedule_mode: Optional[str] = None
    schedule_interval_hours: Optional[int] = None
    schedule_interval_minutes: Optional[int] = None
    schedule_fixed_times: Optional[List[str]] = None
    facebook_account_id: Optional[str] = None
    post_image_mode: str = "UPLOAD"
    post_image_prompt: Optional[str] = None



class TargetURLImport(BaseModel):
    urls: List[str]


class TargetURLOut(BaseModel):
    id: str
    campaign_id: str
    url: str
    platform: str
    status: str
    assigned_account_id: Optional[str] = None
    assigned_account_username: Optional[str] = None
    monitor_source_url: Optional[str] = None
    processed_at: Optional[str] = None
    error_message: Optional[str] = None


class TargetURLUpdate(BaseModel):
    url: Optional[str] = None
    status: Optional[str] = Field(None, pattern="^(PENDING|PROCESSING|SUCCESS|FAILED|SKIPPED)$")


class AssignAccountToURL(BaseModel):
    account_id: Optional[str] = None  # None means unassign



class CommentTemplateImport(BaseModel):
    templates: List[str]


class FacebookTemplateCreate(BaseModel):
    content: str
    image_url: Optional[str] = None
    first_comment: Optional[str] = None
    comment_delay_minutes: Optional[int] = Field(0, ge=0)


class CommentTemplateUpdate(BaseModel):
    content: Optional[str] = None
    category: Optional[str] = None
    language: Optional[str] = None
    priority: Optional[str] = None
    status: Optional[str] = Field(None, pattern="^(ACTIVE|INACTIVE)$")
    image_url: Optional[str] = None
    first_comment: Optional[str] = None
    comment_delay_minutes: Optional[int] = Field(None, ge=0)


class CommentTemplateOut(BaseModel):
    id: str
    campaign_id: str
    content: str
    category: str
    language: str
    priority: str
    status: str
    image_url: Optional[str] = None
    first_comment: Optional[str] = None
    comment_delay_minutes: Optional[int] = 0
    published_at: Optional[str] = None
