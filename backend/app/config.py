from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Database
    database_url: str

    # Redis
    redis_url: str = "redis://redis:6379"

    # LLM Choice
    llm_provider: str = "bedrock"  # "bedrock" or "ollama"
    ollama_base_url: str = "http://host.docker.internal:11434"
    ollama_model: str = "llama3"

    # AWS Bedrock
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
    aws_region: str = "us-east-1"
    aws_endpoint_url: str = ""
    bedrock_model_id: str = "us.anthropic.claude-sonnet-4-6"          # vision tasks
    bedrock_text_model_id: str = "us.anthropic.claude-haiku-4-5-20251001-v1:0"  # text/chat tasks

    # Auth
    jwt_secret: str = "dev-secret-change-in-production"
    household_username: str = "household"
    household_password_hash: str = ""
    cookie_secure: bool = False  # set True in production (requires HTTPS)

    # Observability
    log_level: str = "INFO"
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""
    langfuse_host: str = "https://cloud.langfuse.com"

    # Web Push (VAPID)
    # Generate keys: docker compose exec api poetry run python -c "
    #   from cryptography.hazmat.primitives.asymmetric import ec
    #   from cryptography.hazmat.primitives import serialization
    #   import base64, json
    #   k = ec.generate_private_key(ec.SECP256R1())
    #   priv = base64.urlsafe_b64encode(k.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())).decode()
    #   pub = base64.urlsafe_b64encode(k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)).rstrip(b'=').decode()
    #   print(json.dumps({'VAPID_PRIVATE_KEY': priv, 'VAPID_PUBLIC_KEY': pub}))"
    vapid_private_key: str = ""
    vapid_public_key: str = ""
    vapid_claims_email: str = "admin@whatsfortea.local"

    # Google OAuth SSO
    google_client_id: str = ""
    google_client_secret: str = ""

    # Email / SMTP (for password reset)
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    app_url: str = "http://localhost:3000"

    # Disable interactive API docs in production
    enable_api_docs: bool = False


settings = Settings()
