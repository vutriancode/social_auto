from pydantic_settings import BaseSettings
from pydantic import ConfigDict

class Settings(BaseSettings):
    MONGODB_URL: str = "mongodb://localhost:27017"
    DATABASE_NAME: str = "social_campaign_db"
    REDIS_URL: str = "redis://localhost:6379/0"
    
    JWT_SECRET: str = "supersecretkeyforcampaignmanagementsystem123456!"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440  # 24 hours for development ease

    OPENAI_API_KEY: str = ""

    model_config = ConfigDict(env_file=".env", extra="ignore")

settings = Settings()

# Random cooldown range between consecutive Threads comments from the same account.
# Each job reservation picks a random value in [MIN, MAX] to mimic human timing.
ACCOUNT_COMMENT_COOLDOWN_SECONDS = 120       # kept for backwards compat (used as min)
ACCOUNT_COMMENT_COOLDOWN_MIN_SECONDS = 120
ACCOUNT_COMMENT_COOLDOWN_MAX_SECONDS = 300
