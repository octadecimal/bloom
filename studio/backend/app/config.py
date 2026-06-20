from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    mongo_url: str = "mongodb://localhost:27017"
    mongo_db: str = "bloom_studio"
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    default_model: str = "meta-llama/llama-3.2-3b-instruct:free"
    llm_backend: str = "openrouter"  # "openrouter" | "fake"
    fake_token_delay: float = 0.0


def get_settings() -> Settings:
    return Settings()
