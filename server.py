"""
TradeDoc AI Server — LangGraph Edition
═════════════════════════════════════════
Flask backend that:
  1. Serves the UI static files
  2. Exposes LangGraph agent flows via REST endpoints
  3. AI email extraction, PDF compilation, and validation
  4. MongoDB document storage via pymongo (tradedocai database)

Supported document types:
  - FX NDF (Non-Deliverable Forward)
  - IRS  (Interest Rate Swap — multiple exhibits)
  - CDS  (Credit Default Swap)
  - Equity TRS (Equity Total Return Swap — Model I & II)

PDF Policy:
  - PDFs are TEMPORARY — stored per-session, deleted when a new PDF is created
  - No permanent PDF storage on disk

Usage:
    pip install -r requirements.txt
    python server.py
    → http://localhost:5055
"""

import os
import base64
import sys
import json
import uuid
import time
import shutil
import traceback
from datetime import datetime, timedelta, timezone
from functools import wraps
from urllib.parse import unquote, urlparse
import re
from dotenv import load_dotenv
load_dotenv()  # local development only; production injects env vars at runtime
from bson import ObjectId
from bson.errors import InvalidId
from pymongo import MongoClient
from pymongo.errors import ConfigurationError, PyMongoError, ServerSelectionTimeoutError
from flask import Flask, Response, g, request, jsonify, send_file, send_from_directory
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

# ── Google Cloud Storage (optional) ───────
try:
    from google.cloud import storage  # type: ignore[import-untyped]
    GCS_AVAILABLE = True
except ImportError:
    GCS_AVAILABLE = False
    storage = None  # type: ignore[assignment]

try:
    import certifi
except ImportError:
    certifi = None

# ── Path setup ────────────────────────────
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT_DIR)
sys.path.insert(0, os.path.join(ROOT_DIR, "templates", "FX_Trade_Confirmation"))
sys.path.insert(0, os.path.join(ROOT_DIR, "templates", "IRS_Confirmation"))
sys.path.insert(0, os.path.join(ROOT_DIR, "templates", "CDS_Confirmation"))
sys.path.insert(0, os.path.join(ROOT_DIR, "templates", "Equity_TRS"))

# Import LangGraph flows
from agents.graph import ai_create_graph, pdf_compile_graph, validation_graph
from agents.gemini_helper import call_gemini, call_gemini_stream
from agents.groq_helper import call_groq, call_groq_stream

# Import raw generators as fallback for direct PDF compilation
# Lazy imports with fallbacks — prevents entire server from crashing
# if a single template module is missing from the deployment image.
_generate_fx_pdf_direct = None
_generate_irs_pdf_direct = None
_generate_cds_pdf_direct = None
_generate_equity_trs_pdf_direct = None

try:
    from generate_fx_ndf import generate_pdf as _generate_fx_pdf_direct
except ModuleNotFoundError:
    print("  ⚠️  generate_fx_ndf module not found — FX NDF direct PDF generation disabled")

try:
    from generate_irs import generate_pdf as _generate_irs_pdf_direct
except ModuleNotFoundError:
    print("  ⚠️  generate_irs module not found — IRS direct PDF generation disabled")

try:
    from generate_cds import generate_pdf as _generate_cds_pdf_direct
except ModuleNotFoundError:
    print("  ⚠️  generate_cds module not found — CDS direct PDF generation disabled")

try:
    from generate_equity_trs import generate_pdf as _generate_equity_trs_pdf_direct
except ModuleNotFoundError:
    print("  ⚠️  generate_equity_trs module not found — Equity TRS direct PDF generation disabled")

# Adobe PDF Services SDK (for Word conversion)
try:
    from adobe.pdfservices.operation.auth.service_principal_credentials import ServicePrincipalCredentials
    from adobe.pdfservices.operation.pdf_services import PDFServices
    from adobe.pdfservices.operation.pdf_services_media_type import PDFServicesMediaType
    from adobe.pdfservices.operation.pdfjobs.jobs.export_pdf_job import ExportPDFJob
    from adobe.pdfservices.operation.pdfjobs.params.export_pdf.export_pdf_params import ExportPDFParams
    from adobe.pdfservices.operation.pdfjobs.params.export_pdf.export_pdf_target_format import ExportPDFTargetFormat
    from adobe.pdfservices.operation.pdfjobs.params.export_pdf.export_ocr_locale import ExportOCRLocale
    from adobe.pdfservices.operation.pdfjobs.result.export_pdf_result import ExportPDFResult
    ADOBE_AVAILABLE = True
except ImportError:
    ADOBE_AVAILABLE = False

# ── Flask app ─────────────────────────────
app = Flask(__name__, static_folder=os.path.join(ROOT_DIR, "ui-app", "out"))
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("MAX_CONTENT_LENGTH_BYTES", str(2 * 1024 * 1024)))

_cors_origins = [
    origin.strip()
    for origin in os.environ.get("CORS_ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5055").split(",")
    if origin.strip()
]
CORS(
    app,
    resources={r"/*": {"origins": _cors_origins}},
    expose_headers=["Content-Disposition", "X-TradeDoc-File-Id"],
)

# ── Runtime / Temp PDF directory ──────────
APP_ENV = os.environ.get("APP_ENV") or os.environ.get("FLASK_ENV") or "development"
IS_PRODUCTION = APP_ENV.lower() in {"prod", "production"}
TEMP_PDF_DIR = os.path.join(ROOT_DIR, "output_confirmations", "temp")
os.makedirs(TEMP_PDF_DIR, exist_ok=True)
PDF_RETENTION_SECONDS = int(float(os.environ.get("PDF_RETENTION_HOURS", "24")) * 60 * 60)
PDF_CLEANUP_INTERVAL_SECONDS = int(os.environ.get("PDF_CLEANUP_INTERVAL_SECONDS", "3600"))
_last_pdf_cleanup = 0.0

# ── Google Cloud Storage ──────────────────
GCS_BUCKET_NAME = os.environ.get("GCS_BUCKET_NAME", "")
GCS_CREDENTIALS_PATH = os.path.abspath(
    os.environ.get(
        "GOOGLE_APPLICATION_CREDENTIALS",
        os.path.join(ROOT_DIR, "gcs-service-account.json"),
    )
)
GCS_SIGNED_URL_EXPIRY_MINUTES = int(os.environ.get("GCS_SIGNED_URL_EXPIRY_MINUTES", "15"))
_gcs_client = None


def _storage_client():
    """Lazy-init singleton for GCS client. Returns None if GCS is not configured."""
    global _gcs_client
    if not GCS_AVAILABLE:
        return None
    if _gcs_client is None:
        if not GCS_BUCKET_NAME:
            print("  ⚠️  GCS_BUCKET_NAME not set — GCS archival disabled")
            return None
        if not os.path.exists(GCS_CREDENTIALS_PATH):
            print(f"  ⚠️  GCS credentials not found at {GCS_CREDENTIALS_PATH} — GCS archival disabled")
            return None
        _gcs_client = storage.Client.from_service_account_json(GCS_CREDENTIALS_PATH)  # type: ignore[union-attr]
    return _gcs_client


def _upload_to_gcs(local_pdf_path: str, user_id: str, doc_type: str) -> str | None:
    """Upload a PDF to Google Cloud Storage. Returns the GCS object path or None on failure."""
    client = _storage_client()
    if not client:
        return None
    try:
        bucket = client.bucket(GCS_BUCKET_NAME)
        filename = os.path.basename(local_pdf_path)
        object_path = f"{user_id}/{doc_type}/{filename}"
        blob = bucket.blob(object_path)
        blob.upload_from_filename(local_pdf_path, content_type="application/pdf")
        print(f"  ☁️  Uploaded to GCS: gs://{GCS_BUCKET_NAME}/{object_path}")
        return object_path
    except Exception:
        traceback.print_exc()
        return None


def _download_from_gcs(gcs_object_path: str) -> bytes | None:
    """Download PDF bytes from GCS. Returns None on failure."""
    client = _storage_client()
    if not client:
        return None
    try:
        bucket = client.bucket(GCS_BUCKET_NAME)
        blob = bucket.blob(gcs_object_path)
        if not blob.exists():
            return None
        return blob.download_as_bytes()
    except Exception:
        traceback.print_exc()
        return None


def _generate_gcs_signed_url(gcs_object_path: str) -> str | None:
    """Generate a time-limited signed URL for a GCS object."""
    client = _storage_client()
    if not client:
        return None
    try:
        bucket = client.bucket(GCS_BUCKET_NAME)
        blob = bucket.blob(gcs_object_path)
        if not blob.exists():
            return None
        return blob.generate_signed_url(
            version="v4",
            expiration=timedelta(minutes=GCS_SIGNED_URL_EXPIRY_MINUTES),
            method="GET",
            response_disposition="inline",
        )
    except Exception:
        traceback.print_exc()
        return None


# ── Auth ──────────────────────────────────
AUTH_SECRET = os.environ.get("AUTH_SECRET") or os.environ.get("SECRET_KEY")
if IS_PRODUCTION and not AUTH_SECRET:
    raise RuntimeError("AUTH_SECRET is required when APP_ENV=production")
if IS_PRODUCTION and AUTH_SECRET and len(AUTH_SECRET) < 16:
    raise RuntimeError("AUTH_SECRET must be at least 16 characters in production")
AUTH_SECRET = AUTH_SECRET or "dev-only-change-me"
AUTH_SALT = "tradedocai-auth-v1"
AUTH_MAX_AGE_SECONDS = int(os.environ.get("AUTH_MAX_AGE_SECONDS", str(60 * 60 * 24 * 7)))
TOKEN_SERIALIZER = URLSafeTimedSerializer(AUTH_SECRET, salt=AUTH_SALT)
DEMO_EMAIL = os.environ.get("DEMO_USER_EMAIL", "demo@tradedoc.ai").lower()
DEMO_PASSWORD = os.environ.get("DEMO_USER_PASSWORD", "demo123")
DEMO_NAME = os.environ.get("DEMO_USER_NAME", "Demo User")
ENABLE_DEMO_USER = os.environ.get("ENABLE_DEMO_USER", "true" if not IS_PRODUCTION else "false").lower() == "true"
VALID_DOC_TYPES = {"fx_ndf", "irs", "cds", "equity_trs"}
DOCUSEAL_API_KEY = os.environ.get("DOCUSEAL_API_KEY", "")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")

def _json_body(required: bool = True) -> dict:
    body = request.get_json(silent=True)
    if body is None:
        if required:
            raise ValueError("JSON body required")
        return {}
    if not isinstance(body, dict):
        raise ValueError("JSON body must be an object")
    return body


def _auth_token_for(user_id: str) -> str:
    return TOKEN_SERIALIZER.dumps({"user_id": user_id})


def _public_user(user: dict) -> dict:
    return {
        "id": str(user["_id"]), 
        "email": user.get("email", ""), 
        "name": user.get("name", "User"),
        "city": user.get("city", ""),
        "address": user.get("address", ""),
        "country": user.get("country", "")
    }


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_demo_user(db):
    if not ENABLE_DEMO_USER:
        return None
    existing = db.users.find_one({"email": DEMO_EMAIL})
    if existing:
        return existing
    now = _iso_now()
    user = {
        "email": DEMO_EMAIL,
        "name": DEMO_NAME,
        "password_hash": generate_password_hash(DEMO_PASSWORD),
        "created_at": now,
        "updated_at": now,
        "is_demo": True,
    }
    result = db.users.insert_one(user)
    user["_id"] = result.inserted_id
    return user


def _current_user_from_request():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header.split(" ", 1)[1].strip()
    try:
        payload = TOKEN_SERIALIZER.loads(token, max_age=AUTH_MAX_AGE_SECONDS)
        user_id = payload.get("user_id")
        if not user_id:
            return None
        return get_db().users.find_one({"_id": ObjectId(user_id)})
    except (BadSignature, SignatureExpired, InvalidId):
        return None


def require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if request.method == "OPTIONS":
            # Return 200 OK for CORS preflight — never forward to the view
            # (the view may run DB queries that could fail and return non-200)
            return "", 200
        user = _current_user_from_request()
        if not user:
            return jsonify({"error": "Authentication required"}), 401
        g.current_user = user
        g.current_user_id = str(user["_id"])
        return fn(*args, **kwargs)
    return wrapper


def _serialise_chat_session(session: dict) -> dict:
    return {
        "id": str(session["_id"]),
        "title": session.get("title", "New chat"),
        "created_at": session.get("created_at", ""),
        "updated_at": session.get("updated_at", ""),
    }


def _serialise_chat_message(message: dict) -> dict:
    return {
        "id": str(message["_id"]),
        "session_id": str(message["session_id"]),
        "role": message.get("role", "assistant"),
        "content": message.get("content", ""),
        "action": message.get("action"),
        "created_at": message.get("created_at", ""),
    }


def _chat_session_for_user(db, session_id: str | None):
    if not session_id:
        return None
    try:
        return db.chat_sessions.find_one({
            "_id": ObjectId(session_id),
            "user_id": g.current_user_id,
        })
    except InvalidId:
        return None


def _create_chat_session(db, first_message: str = "") -> dict:
    now = _iso_now()
    title = first_message.strip().replace("\n", " ")[:60] or "New chat"
    session = {
        "user_id": g.current_user_id,
        "title": title,
        "created_at": now,
        "updated_at": now,
    }
    result = db.chat_sessions.insert_one(session)
    session["_id"] = result.inserted_id
    return session


def _save_chat_message(db, session_id: ObjectId, role: str, content: str, action: str | None = None) -> dict:
    now = _iso_now()
    message = {
        "session_id": session_id,
        "user_id": g.current_user_id,
        "role": role,
        "content": content,
        "action": action,
        "created_at": now,
    }
    result = db.chat_messages.insert_one(message)
    message["_id"] = result.inserted_id
    db.chat_sessions.update_one(
        {"_id": session_id, "user_id": g.current_user_id},
        {"$set": {"updated_at": now}},
    )
    return message


def _load_chat_history(db, session_id: ObjectId, limit: int = 20) -> list[dict]:
    messages = list(
        db.chat_messages.find({"session_id": session_id, "user_id": g.current_user_id})
        .sort("created_at", -1)
        .limit(limit)
    )
    messages.reverse()
    return messages


def _build_chat_prompt(user_msg: str, history: list[dict]) -> str:
    current_time = datetime.now(timezone.utc).strftime("%B %d, %Y")
    prompt = f"You are TradeDoc Copilot, a helpful and intelligent AI assistant. Today's date is {current_time}. "
    prompt += "While you specialize in TradeDoc AI (derivatives like IRS, CDS, FX NDF, Equity TRS), you are happy to help with general questions too. "
    prompt += "Be conversational, friendly, and smart. "
    prompt += "CRITICAL NAVIGATION RULES:\n"
    prompt += "1. If the user mentions 'extract', 'upload', 'file', or 'AI extraction', use the 'ai' token (e.g., [NAVIGATE:ai]).\n"
    prompt += "2. If the user's request is ONLY navigation, respond ONLY with the token.\n\n"
    prompt += "Possible page names and their meanings:\n"
    prompt += "- landing: Home, Dashboard, Overview\n"
    prompt += "- analytics: Charts, Performance, Analytics, Stats\n"
    prompt += "- ai: AI Extraction, Upload Trade, Document Extraction\n"
    prompt += "- settings-profile: Profile, User Settings\n"
    prompt += "- settings-preference: Preferences, Model selection\n"
    prompt += "- settings-password: Password, Security\n"
    prompt += "- my-documents: My Documents, History, Saved Trades\n"
    prompt += "Example: [NAVIGATE:analytics]\n\n"

    for msg in history:
        role = "User" if msg.get("role") == "user" else "Assistant"
        prompt += f"{role}: {msg.get('content', '')}\n"

    prompt += f"User: {user_msg}\nAssistant:"
    return prompt


def _extract_chat_action(reply: str, user_msg: str) -> tuple[str, str | None]:
    action = None
    
    # 1. Parse explicit navigation verbs in the user's message first
    user_msg_lower = user_msg.lower().strip()
    nav_verbs = ["navigate", "go to", "open", "show", "switch to", "take me to", "move to"]
    has_nav_verb = any(verb in user_msg_lower for verb in nav_verbs)
    
    # Also check if the user message itself is an exact single-word page name
    exact_pages = {
        "landing": "landing", "home": "landing", "dashboard": "landing",
        "analytics": "analytics", "charts": "analytics", "stats": "analytics",
        "ai": "ai", "extraction": "ai", "upload": "ai",
        "settings": "settings-profile", "profile": "settings-profile",
        "documents": "my-documents", "history": "my-documents",
    }
    is_exact_page = user_msg_lower in exact_pages

    # 2. Extract LLM token if it exists
    nav_pattern = r"\[NAVIGATE:?\s*([\w\-]+)\]"
    nav_match = re.search(nav_pattern, reply, re.IGNORECASE)

    # Clean the reply by removing the token regardless of whether we use it
    clean_reply = reply
    llm_action = None
    if nav_match:
        candidate = nav_match.group(1).lower().strip()
        if not candidate.startswith("form-"):
            llm_action = candidate
        clean_reply = re.sub(nav_pattern, "", reply, flags=re.IGNORECASE).strip()

    # 3. ONLY allow navigation if the user explicitly intended to navigate (verb present or exact page name match)
    if has_nav_verb or is_exact_page:
        # If the LLM outputted a valid token, use it
        if llm_action:
            action = llm_action
        else:
            # Fallback to local keyword boundaries matching
            keywords = {
                "landing": "landing", "home": "landing", "dashboard": "landing",
                "analytics": "analytics", "charts": "analytics", "stats": "analytics",
                "ai": "ai", "extraction": "ai", "upload": "ai",
                "settings": "settings-profile", "profile": "settings-profile", "user setting": "settings-profile",
                "preference": "settings-preference", "model": "settings-preference",
                "password": "settings-password", "security": "settings-password",
                "documents": "my-documents", "history": "my-documents",
            }
            for kw, target in keywords.items():
                pattern = rf"\b{re.escape(kw)}\b"
                if re.search(pattern, user_msg_lower):
                    action = target
                    break
    else:
        # If no explicit navigation verb is in the user message, we discard the LLM navigation action completely!
        action = None

    if action:
        # Guarantee a helpful confirmation message if user made a navigation request
        nav_only_phrases = ["navigate", "go to", "show", "open", "take me to", "switch to"]
        is_nav_only = any(user_msg_lower.startswith(p) for p in nav_only_phrases) or not clean_reply.strip()
        if is_nav_only and not re.search(r"\?", user_msg_lower):
            clean_reply = f"Sure, opening {action.replace('-', ' ')} for you."

    return clean_reply, action


def _detect_fast_navigation(user_msg: str) -> str | None:
    """Detects simple navigation commands without calling AI to save time/cost."""
    msg = user_msg.lower().strip()
    
    # 1. We ONLY fast-navigate if the user explicitly uses a navigation verb.
    nav_verbs = ["navigate", "go to", "open", "show", "switch to", "take me to", "move to"]
    has_nav_verb = any(verb in msg for verb in nav_verbs)
    
    # Check if user message itself is exactly equal to one of the raw page names
    exact_pages = {
        "landing": "landing", "home": "landing", "dashboard": "landing",
        "analytics": "analytics", "charts": "analytics", "stats": "analytics",
        "ai": "ai", "extraction": "ai", "upload": "ai",
        "settings": "settings-profile", "profile": "settings-profile",
        "documents": "my-documents", "history": "my-documents",
    }
    if msg in exact_pages:
        return exact_pages[msg]
        
    if not has_nav_verb:
        return None

    # Common navigation keywords map
    keywords = {
        "landing": "landing", "home": "landing", "dashboard": "landing",
        "analytics": "analytics", "charts": "analytics", "stats": "analytics",
        "ai": "ai", "extraction": "ai", "upload": "ai",
        "settings": "settings-profile", "profile": "settings-profile",
        "documents": "my-documents", "history": "my-documents",
    }
    
    # Standard navigation patterns: "go to cds", "open analytics" etc.
    for prefix in nav_verbs:
        if msg.startswith(prefix):
            remaining = msg[len(prefix):].strip()
            # Check for whole word match to avoid substring collisions
            for kw, target in keywords.items():
                pattern = rf"\b{re.escape(kw)}\b"
                if re.search(pattern, remaining):
                    print(f"  ⚡ Fast Navigation Triggered: {target}")
                    return target
                    
    # Double check short messages with explicit verbs
    if len(msg.split()) <= 4:
        for kw, target in keywords.items():
            pattern = rf"\b{re.escape(kw)}\b"
            if re.search(pattern, msg):
                print(f"  ⚡ Fast Navigation Triggered (Keyword): {target}")
                return target
                    
    return None

# ── MongoDB ───────────────────────────────
MONGO_URI = os.getenv("MONGO_URI") or ("" if IS_PRODUCTION else "mongodb://localhost:27017/tradedocai")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME")
app.config["MONGO_URI"] = MONGO_URI
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "dev-secret-12345")

# Initialize Limiter
limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=["500 per day", "100 per hour"],
    storage_uri="memory://",
)
_mongo_client = None
_db = None


def _mongo_db_name_from_uri(uri: str) -> str:
    """Read the optional database name from a Mongo URI path."""
    try:
        parsed = urlparse(uri)
        path = parsed.path.lstrip("/")
        return unquote(path) if path else ""
    except Exception:
        return ""


def _mongo_db_name() -> str:
    return MONGO_DB_NAME or _mongo_db_name_from_uri(MONGO_URI) or "tradedocai"


def _mongo_client_options() -> dict:
    options = {
        "serverSelectionTimeoutMS": int(os.environ.get("MONGO_SERVER_SELECTION_TIMEOUT_MS", "10000")),
        "connectTimeoutMS": int(os.environ.get("MONGO_CONNECT_TIMEOUT_MS", "10000")),
        "socketTimeoutMS": int(os.environ.get("MONGO_SOCKET_TIMEOUT_MS", "20000")),
        "appname": "TradeDocAI",
    }

    uri_lower = MONGO_URI.lower()
    uses_atlas = MONGO_URI.startswith("mongodb+srv://") or "mongodb.net" in uri_lower
    has_tls_option = "tls=" in uri_lower or "ssl=" in uri_lower
    if uses_atlas:
        if not has_tls_option:
            options["tls"] = True
        if certifi is not None:
            options["tlsCAFile"] = certifi.where()

    return options


def _validate_mongo_config() -> None:
    if not MONGO_URI:
        raise ConfigurationError("MONGO_URI is required")

    if IS_PRODUCTION:
        parsed = urlparse(MONGO_URI)
        host = parsed.hostname or ""
        local_hosts = {"localhost", "127.0.0.1", "mongo"}
        if host in local_hosts or host.endswith(".local"):
            raise ConfigurationError(
                "Production MONGO_URI must point to a managed MongoDB service such as Atlas, not a local Docker host."
            )


def get_db():
    """Lazy-connect to MongoDB. Returns the tradedocai database."""
    global _mongo_client, _db
    if _db is None:
        _validate_mongo_config()
        client = MongoClient(MONGO_URI, **_mongo_client_options())
        db = client[_mongo_db_name()]
        try:
            db.command("ping")
        except Exception:
            client.close()
            raise
        _mongo_client = client
        _db = db
        _ensure_indexes(_db)
    return _db


def _ensure_indexes(db):
    try:
        db.users.create_index("email", unique=True)
        db.documents.create_index([("user_id", 1), ("updated_at", -1)])
        db.documents.create_index([("user_id", 1), ("doc_type", 1)])
        db.pdf_jobs.create_index([("user_id", 1), ("created_at", -1)])
        db.chat_sessions.create_index([("user_id", 1), ("updated_at", -1)])
        db.chat_messages.create_index([("session_id", 1), ("created_at", 1)])
        db.chat_messages.create_index([("user_id", 1), ("created_at", -1)])
    except Exception:
        traceback.print_exc()


def _database_error_response(error: Exception):
    traceback.print_exc()
    return jsonify({
        "error": "Database connection failed. Check MONGO_URI, MongoDB Atlas network access/IP allowlist, credentials, and TLS settings.",
        "detail": str(error) if not IS_PRODUCTION else "Database is unavailable",
    }), 503


def _safe_user_id() -> str:
    return getattr(g, "current_user_id", "anonymous")


def _cleanup_old_generated_files(force: bool = False) -> None:
    """Remove generated PDF/Word job folders older than PDF_RETENTION_HOURS."""
    global _last_pdf_cleanup
    if PDF_RETENTION_SECONDS <= 0:
        return

    now = time.time()
    if not force and now - _last_pdf_cleanup < PDF_CLEANUP_INTERVAL_SECONDS:
        return
    _last_pdf_cleanup = now

    cutoff = now - PDF_RETENTION_SECONDS
    if not os.path.isdir(TEMP_PDF_DIR):
        return

    removed_jobs: list[str] = []
    for user_name in os.listdir(TEMP_PDF_DIR):
        user_dir = os.path.join(TEMP_PDF_DIR, user_name)
        if not os.path.isdir(user_dir):
            continue
        for job_name in os.listdir(user_dir):
            job_dir = os.path.join(user_dir, job_name)
            if not os.path.isdir(job_dir):
                continue
            try:
                if os.path.getmtime(job_dir) < cutoff:
                    shutil.rmtree(job_dir)
                    removed_jobs.append(job_name)
            except OSError:
                traceback.print_exc()

    if removed_jobs:
        try:
            get_db().pdf_jobs.delete_many({"job_id": {"$in": removed_jobs}})
        except Exception:
            traceback.print_exc()
        print(f"  🧹 Cleaned {len(removed_jobs)} expired generated PDF job(s)")


def _make_job_dir() -> tuple[str, str]:
    _cleanup_old_generated_files()
    job_id = uuid.uuid4().hex
    job_dir = os.path.join(TEMP_PDF_DIR, _safe_user_id(), job_id)
    os.makedirs(job_dir, exist_ok=True)
    return job_id, job_dir


def _file_id(job_id: str, filename: str) -> str:
    return f"{job_id}:{filename}"


def _resolve_generated_pdf(body: dict) -> tuple[str | None, str | None]:
    """Resolve a generated PDF by job-scoped file id, with legacy filename fallback."""
    user_id = _safe_user_id()
    file_id = body.get("pdf_file_id") or body.get("file_id") or ""
    if file_id and ":" in file_id:
        job_id, filename = file_id.split(":", 1)
        job_id = secure_filename(job_id)
        job_dir = os.path.abspath(os.path.join(TEMP_PDF_DIR, user_id, job_id))
        allowed_root = os.path.abspath(os.path.join(TEMP_PDF_DIR, user_id))
        # Try the raw filename as stored (new format — _file_id no longer secures)
        pdf_path = os.path.join(job_dir, filename)
        if os.path.exists(pdf_path) and pdf_path.startswith(allowed_root + os.sep):
            return pdf_path, filename
        # Fallback: try secure_filename version (legacy docs stored with secured names)
        filename_secured = secure_filename(filename)
        if filename_secured != filename:
            pdf_path = os.path.join(job_dir, filename_secured)
            if os.path.exists(pdf_path) and pdf_path.startswith(allowed_root + os.sep):
                return pdf_path, filename_secured
        # Last resort: find any PDF in the job directory
        if os.path.isdir(job_dir):
            pdfs = sorted([f for f in os.listdir(job_dir) if f.lower().endswith(".pdf")])
            if pdfs:
                pdf_path = os.path.join(job_dir, pdfs[0])
                if pdf_path.startswith(allowed_root + os.sep):
                    return pdf_path, pdfs[0]

    legacy_name = secure_filename(body.get("pdf_filename", ""))
    if not legacy_name:
        return None, None
    user_root = os.path.abspath(os.path.join(TEMP_PDF_DIR, user_id))
    for root, _, files in os.walk(user_root) if os.path.exists(user_root) else []:
        if legacy_name in files:
            pdf_path = os.path.abspath(os.path.join(root, legacy_name))
            if pdf_path.startswith(user_root + os.sep):
                return pdf_path, legacy_name
    return None, legacy_name


def _obj_id_to_str(doc: dict) -> dict:
    """Convert MongoDB ObjectId _id to string for JSON serialisation."""
    if doc and "_id" in doc:
        doc["_id"] = str(doc["_id"])
    return doc


# ═══════════════════════════════════════════
# STATIC FILE SERVING (UI)
# ═══════════════════════════════════════════

@app.route("/")
def serve_index():
    static_dir = app.static_folder or ""
    return send_from_directory(static_dir, "index.html")

@app.route("/<path:path>")
def serve_static(path):
    static_dir = app.static_folder or ""
    # Don't catch API routes
    if (path.startswith("generate/") or path.startswith("ai/") or
            path.startswith("api/") or path == "validate" or
            path.startswith("convert/")):
        return jsonify({"error": "Not found"}), 404

    full_path = os.path.join(static_dir, path)
    if os.path.exists(full_path) and os.path.isfile(full_path):
        return send_from_directory(static_dir, path)

    if not os.path.splitext(path)[1]:
        if os.path.exists(full_path + ".html"):
            return send_from_directory(static_dir, path + ".html")
        if os.path.exists(os.path.join(full_path, "index.html")):
            return send_from_directory(static_dir, os.path.join(path, "index.html"))

    return send_from_directory(static_dir, "index.html")


# ═══════════════════════════════════════════
# MONGODB DOCUMENT CRUD ENDPOINTS
# ═══════════════════════════════════════════

@app.route("/ping", methods=["GET"])
def api_ping():
    return jsonify({"status": "ok", "message": "TradeDoc AI Server is reachable"}), 200


@app.route("/health/live", methods=["GET"])
def health_live():
    return jsonify({"status": "live"}), 200


@app.route("/health/ready", methods=["GET"])
def health_ready():
    checks = {"mongo": False, "gemini_configured": bool(os.environ.get("GEMINI_API_KEY"))}
    errors = {}
    status = 200
    try:
        get_db().command("ping")
        checks["mongo"] = True
    except Exception as e:
        status = 503
        errors["mongo"] = str(e) if not IS_PRODUCTION else "Database is unavailable"
    return jsonify({"status": "ready" if status == 200 else "not_ready", "checks": checks, "errors": errors}), status


@app.route("/api/auth/signup", methods=["POST"])
def api_signup():
    try:
        body = _json_body()
        name = str(body.get("name", "")).strip()
        email = str(body.get("email", "")).strip().lower()
        password = str(body.get("password", ""))
        if not name or not email or not password:
            return jsonify({"error": "Name, email and password are required"}), 400
        if "@" not in email or len(email) > 254:
            return jsonify({"error": "Valid email is required"}), 400
        if len(password) < 8:
            return jsonify({"error": "Password must be at least 8 characters"}), 400

        now = datetime.now(timezone.utc).isoformat()
        user = {
            "name": name[:120],
            "email": email,
            "password_hash": generate_password_hash(password),
            "created_at": now,
            "updated_at": now,
        }
        db = get_db()
        if db.users.find_one({"email": email}):
            return jsonify({"error": "Account already exists for this email"}), 409
        result = db.users.insert_one(user)
        user["_id"] = result.inserted_id
        return jsonify({"token": _auth_token_for(str(user["_id"])), "user": _public_user(user)}), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        if isinstance(e, (ServerSelectionTimeoutError, PyMongoError)):
            return _database_error_response(e)
        traceback.print_exc()
        return jsonify({"error": "Signup failed"}), 500


@app.route("/api/auth/login", methods=["POST"])
def api_login():
    try:
        body = _json_body()
        email = str(body.get("email", "")).strip().lower()
        password = str(body.get("password", ""))
        if not email or not password:
            return jsonify({"error": "Email and password are required"}), 400

        db = get_db()
        if email == DEMO_EMAIL and ENABLE_DEMO_USER:
            _ensure_demo_user(db)
        user = db.users.find_one({"email": email})
        if not user or not check_password_hash(user.get("password_hash", ""), password):
            return jsonify({"error": "Invalid email or password"}), 401
        return jsonify({"token": _auth_token_for(str(user["_id"])), "user": _public_user(user)})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        if isinstance(e, (ServerSelectionTimeoutError, PyMongoError)):
            return _database_error_response(e)
        traceback.print_exc()
        return jsonify({"error": "Login failed"}), 500


@app.route("/api/auth/me", methods=["GET"])
@require_auth
def api_auth_me():
    return jsonify({"user": _public_user(g.current_user)})


@app.route("/api/chat/sessions", methods=["GET"])
@require_auth
def api_list_chat_sessions():
    try:
        sessions = list(
            get_db().chat_sessions.find({"user_id": g.current_user_id}).sort("updated_at", -1)
        )
        return jsonify({"sessions": [_serialise_chat_session(session) for session in sessions]})
    except Exception as e:
        if isinstance(e, (ServerSelectionTimeoutError, PyMongoError)):
            return _database_error_response(e)
        traceback.print_exc()
        return jsonify({"error": "Failed to load chat sessions"}), 500


@app.route("/api/chat/sessions", methods=["POST"])
@require_auth
def api_create_chat_session():
    try:
        body = _json_body(required=False)
        session = _create_chat_session(get_db(), str(body.get("title", "")))
        return jsonify({"session": _serialise_chat_session(session)}), 201
    except Exception as e:
        if isinstance(e, (ServerSelectionTimeoutError, PyMongoError)):
            return _database_error_response(e)
        traceback.print_exc()
        return jsonify({"error": "Failed to create chat session"}), 500


@app.route("/api/chat/sessions/<session_id>/messages", methods=["GET"])
@require_auth
def api_list_chat_messages(session_id):
    try:
        db = get_db()
        session = _chat_session_for_user(db, session_id)
        if not session:
            return jsonify({"error": "Chat session not found"}), 404
        messages = list(
            db.chat_messages.find({"session_id": session["_id"], "user_id": g.current_user_id})
            .sort("created_at", 1)
        )
        return jsonify({
            "session": _serialise_chat_session(session),
            "messages": [_serialise_chat_message(message) for message in messages],
        })
    except Exception as e:
        if isinstance(e, (ServerSelectionTimeoutError, PyMongoError)):
            return _database_error_response(e)
        traceback.print_exc()
        return jsonify({"error": "Failed to load chat messages"}), 500


@app.route("/api/chat/sessions/<session_id>", methods=["DELETE"])
@require_auth
def api_delete_chat_session(session_id):
    try:
        db = get_db()
        session = _chat_session_for_user(db, session_id)
        if not session:
            return jsonify({"error": "Chat session not found"}), 404
        db.chat_messages.delete_many({"session_id": session["_id"], "user_id": g.current_user_id})
        db.chat_sessions.delete_one({"_id": session["_id"], "user_id": g.current_user_id})
        return jsonify({"message": "Chat session deleted"})
    except Exception as e:
        if isinstance(e, (ServerSelectionTimeoutError, PyMongoError)):
            return _database_error_response(e)
        traceback.print_exc()
        return jsonify({"error": "Failed to delete chat session"}), 500


@app.route("/api/chat", methods=["POST"])
@require_auth
@limiter.limit("30 per minute")
def api_chat():
    try:
        body = _json_body()
        user_msg = str(body.get("message", "")).strip()
        if not user_msg:
            return jsonify({"error": "Message is required"}), 400

        doc_type = body.get("doc_type")
        schema = body.get("schema")
        current_data = body.get("current_data")
        scope = body.get("scope", "global")  # "local" = ChatSidebar form assistant, "global" = ChatCopilot
        stream = body.get("stream", False)   # SSE streaming for ChatGPT-like real-time output

        # ── Local Scope (ChatSidebar — no DB, no session) ──
        if scope == "local" and doc_type and schema:
            msg_lower = user_msg.lower()

            # Detect intent: missing fields
            is_missing_check = any(kw in msg_lower for kw in [
                "what's missing", "whats missing", "what is missing",
                "missing fields", "remaining", "still need", "left to fill",
                "not filled", "empty fields", "what else", "what do i need"
            ])
            # Detect intent: mistake_check (only review filled, never mention missing)
            is_mistake_check = any(kw in msg_lower for kw in [
                "check", "mistake", "review", "verify", "error",
                "wrong", "correct", "any issues", "look over"
            ]) and not is_missing_check  # Don't route "what's missing" to mistake check
            # Detect intent: field_explain
            is_field_explain = any(kw in msg_lower for kw in [
                "what does", "what is", "explain", "mean",
                "definition", "define", "purpose of"
            ])

            if is_missing_check and current_data is not None:
                from agents.assistant_agent import build_missing_fields_prompt
                prompt = build_missing_fields_prompt(doc_type, current_data, schema)
                if prompt is None:
                    # No missing required fields — craft a simple response
                    reply = "All required fields are filled. You're good to go!"
                    if not stream:
                        return jsonify({"reply": reply, "action": None, "session": None, "message": None})
                    def generate_empty():
                        yield f"data: {json.dumps({'token': reply})}\n\n"
                        yield f"data: {json.dumps({'done': True, 'reply': reply, 'action': None})}\n\n"
                    return Response(generate_empty(), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})
            elif is_mistake_check and current_data:
                from agents.assistant_agent import build_mistake_check_prompt
                prompt = build_mistake_check_prompt(doc_type, current_data, schema)
            elif is_field_explain:
                from agents.assistant_agent import build_field_explain_prompt
                prompt = build_field_explain_prompt(doc_type, user_msg, schema)
            else:
                # Generic local query — use existing assistant prompt with empty history
                from agents.assistant_agent import build_assistant_prompt
                prompt = build_assistant_prompt(user_msg, doc_type, schema, current_data or {}, [])

            # ── SSE Streaming path ──
            if stream:
                def generate():
                    full_text = ""
                    try:
                        for chunk in call_groq_stream(prompt):
                            full_text += chunk
                            yield f"data: {json.dumps({'token': chunk})}\n\n"
                        # Send final message with cleaned full text + action extraction
                        clean_text, action = _extract_chat_action(full_text, user_msg)
                        yield f"data: {json.dumps({'done': True, 'reply': clean_text, 'action': action})}\n\n"
                    except Exception as e:
                        yield f"data: {json.dumps({'error': str(e)[:200]})}\n\n"

                return Response(
                    generate(),
                    mimetype="text/event-stream",
                    headers={
                        "Cache-Control": "no-cache",
                        "X-Accel-Buffering": "no",
                        "Connection": "keep-alive",
                    }
                )

            # ── Non-streaming path (fallback) ──
            reply = call_groq(prompt)
            reply, _ = _extract_chat_action(reply, user_msg)

            return jsonify({
                "reply": reply,
                "action": None,
                "session": None,
                "message": None,
            })

        # ── Global Scope (ChatCopilot — 100% Stateless & History-Free to Save Costs) ──
        # Bypassing all MongoDB writes/reads for conversations, using empty lists for history.
        session_id = body.get("session_id") or "stateless-session"
        
        # 1. Fast-Track Navigation (Skip LLM for simple "go to" commands)
        fast_action = _detect_fast_navigation(user_msg)
        if fast_action and not re.search(r"\?", user_msg):
            reply = f"Sure, opening {fast_action.replace('-', ' ')} for you."
            action = fast_action
        else:
            # 2. Regular AI Response with empty history []
            if doc_type and schema and current_data is not None:
                from agents.assistant_agent import build_assistant_prompt
                prompt = build_assistant_prompt(user_msg, doc_type, schema, current_data, [])
            else:
                prompt = _build_chat_prompt(user_msg, [])

            reply = call_groq(prompt)
            reply, action = _extract_chat_action(reply, user_msg)

        if action:
            print(f"  🚀 Navigation detected: {action}")

        # Construct stateless mock structures to remain fully compatible with UI expectations
        now_ts = _iso_now()
        session_data = {
            "id": session_id,
            "title": "Chat",
            "created_at": now_ts,
            "updated_at": now_ts,
        }
        message_data = {
            "id": "stateless-msg-" + uuid.uuid4().hex,
            "session_id": session_id,
            "role": "assistant",
            "content": reply,
            "action": action,
            "created_at": now_ts,
        }
        
        return jsonify({
            "reply": reply,
            "action": action,
            "session": session_data,
            "message": message_data,
        })
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        if isinstance(e, (ServerSelectionTimeoutError, PyMongoError)):
            return _database_error_response(e)
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/me/update", methods=["POST"], strict_slashes=False)
@require_auth
def api_update_profile():
    """Updates user profile details in MongoDB."""
    try:
        body = request.get_json(silent=True) or {}
        update_data = {}
        for field in ["name", "city", "address", "country"]:
            if field in body: update_data[field] = body[field]
        if not update_data:
            return jsonify({"error": "No valid fields to update"}), 400
        get_db().users.update_one({"_id": ObjectId(g.current_user_id)}, {"$set": update_data})
        user = get_db().users.find_one({"_id": ObjectId(g.current_user_id)})
        if not user:
            return jsonify({"error": "User not found"}), 404
        return jsonify({"message": "Profile updated successfully", "user": _public_user(user)})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/me/change-password", methods=["POST"], strict_slashes=False)
@require_auth
def api_change_password():
    """Changes user password securely."""
    try:
        body = request.get_json(silent=True) or {}
        current_pw, new_pw = body.get("current_password"), body.get("new_password")
        if not current_pw or not new_pw:
            return jsonify({"error": "Missing current or new password"}), 400
        user = get_db().users.find_one({"_id": ObjectId(g.current_user_id)})
        if not user or not check_password_hash(user.get("password_hash", ""), current_pw):
            return jsonify({"error": "Incorrect current password"}), 401
        get_db().users.update_one({"_id": ObjectId(g.current_user_id)}, {"$set": {"password_hash": generate_password_hash(new_pw)}})
        return jsonify({"message": "Password updated successfully"})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


def _sync_docuseal_submission(doc, db, collection):
    """
    Self-healing status sync: Queries DocuSeal REST API to verify live signing status.
    If the document has been fully executed, downloads and archives the completed PDF,
    and transitions the local status to 'signed' automatically.
    """
    submission_id = doc.get("docuseal_submission_id")
    status = doc.get("status")
    
    if not submission_id or status != "dispatched":
        return doc
        
    if not DOCUSEAL_API_KEY:
        print("  ⚠️  DOCUSEAL_API_KEY is not set. Skipping self-healing sync.")
        return doc
        
    import requests
    try:
        url = f"https://api.docuseal.co/submissions/{submission_id}"
        headers = {"X-Auth-Token": DOCUSEAL_API_KEY}
        res = requests.get(url, headers=headers, timeout=10)
        
        if res.status_code == 200:
            sub_data = res.json()
            sub_status = sub_data.get("status")
            print(f"  🔄 DocuSeal Self-Healing Sync: Sub {submission_id} status is '{sub_status}'")
            
            if sub_status == "completed" or sub_data.get("completed_at"):
                documents = sub_data.get("documents", [])
                if not documents:
                    return doc
                    
                completed_pdf_url = documents[0].get("url")
                if not completed_pdf_url:
                    return doc
                    
                # Download completed PDF
                pdf_res = requests.get(completed_pdf_url, headers=headers, timeout=30)
                if pdf_res.status_code != 200:
                    return doc
                    
                signed_pdf_bytes = pdf_res.content
                doc_id = str(doc["_id"])
                user_id = str(doc["user_id"])
                doc_type = doc["doc_type"]
                
                # Archive to GCS
                gcs_signed_path = None
                if GCS_AVAILABLE and GCS_BUCKET_NAME:
                    try:
                        client = _storage_client()
                        if client:
                            bucket = client.bucket(GCS_BUCKET_NAME)
                            object_path = f"{user_id}/{doc_type}/{doc_id}_signed.pdf"
                            blob = bucket.blob(object_path)
                            blob.upload_from_string(signed_pdf_bytes, content_type="application/pdf")
                            gcs_signed_path = object_path
                            print(f"  ☁️  [Sync] Signed PDF saved to GCS: gs://{GCS_BUCKET_NAME}/{object_path}")
                    except Exception as e:
                        print(f"  ⚠️  [Sync] Error saving signed PDF to GCS: {e}")
                        
                # Save locally
                local_signed_dir = os.path.join(TEMP_PDF_DIR, user_id, "signed")
                os.makedirs(local_signed_dir, exist_ok=True)
                local_signed_path = os.path.join(local_signed_dir, f"{doc_id}_signed.pdf")
                with open(local_signed_path, "wb") as f:
                    f.write(signed_pdf_bytes)
                    
                now = datetime.now(timezone.utc).isoformat()
                update_fields = {
                    "status": "closed",
                    "signed_pdf_url": f"/api/documents/{doc_id}/pdf?type=signed",
                    "updated_at": now
                }
                if gcs_signed_path:
                    update_fields["gcs_signed_path"] = gcs_signed_path
                    
                collection.update_one({"_id": doc["_id"]}, {"$set": update_fields})
                print(f"  ✅ [Sync] Document {doc_id} successfully transitioned to 'closed' status via self-healing!")
                
                # Return refreshed document to caller
                updated_doc = collection.find_one({"_id": doc["_id"]})
                if updated_doc:
                    updated_doc["is_draft"] = doc.get("is_draft", False)
                    return updated_doc
    except Exception as e:
        print(f"  ⚠️  [Sync] Error during self-healing sync for doc {doc.get('_id')}: {e}")
        
    return doc


@app.route("/api/documents", methods=["GET"])
@require_auth
def api_list_documents():
    """List all documents (Final) and drafts for the user, with on-demand self-healing status sync."""
    try:
        db = get_db()
        # Fetch from both collections
        final_docs = list(db.documents.find({"user_id": g.current_user_id}).sort("updated_at", -1))
        drafts = list(db.drafts.find({"user_id": g.current_user_id}).sort("updated_at", -1))
        
        # Mark them so frontend knows which is which
        for d in final_docs: d["is_draft"] = False
        for d in drafts: d["is_draft"] = True
        
        # Self-healing sync for active dispatched files
        for i, d in enumerate(final_docs):
            if d.get("status") == "dispatched" and d.get("docuseal_submission_id"):
                final_docs[i] = _sync_docuseal_submission(d, db, db.documents)
                
        for i, d in enumerate(drafts):
            if d.get("status") == "dispatched" and d.get("docuseal_submission_id"):
                drafts[i] = _sync_docuseal_submission(d, db, db.drafts)
        
        all_docs = final_docs + drafts
        # Sort combined list by updated_at
        all_docs.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
        
        return jsonify([_obj_id_to_str(d) for d in all_docs])
    except Exception as e:
        if isinstance(e, (ServerSelectionTimeoutError, PyMongoError)):
            return _database_error_response(e)
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/documents", methods=["POST"])
@require_auth
def api_save_document():
    """Save a new document. If is_draft=True, save to 'drafts', else to 'documents'."""
    try:
        body = _json_body()
        doc_type = str(body.get("doc_type", "")).strip()
        if doc_type not in VALID_DOC_TYPES:
            return jsonify({"error": "Unsupported document type"}), 400
        data = body.get("data", {})
        is_draft = bool(body.get("is_draft", True))
        pdf_file_id = str(body.get("pdf_file_id", "")).strip() or None

        # If finalizing with a pdf_file_id, try to resolve & upload to GCS
        gcs_object_path = None
        if not is_draft and pdf_file_id and ":" in pdf_file_id:
            pdf_path, _ = _resolve_generated_pdf({"pdf_file_id": pdf_file_id})
            if pdf_path and os.path.exists(pdf_path):
                gcs_object_path = _upload_to_gcs(pdf_path, g.current_user_id, doc_type)

        ai_created = bool(body.get("ai_created", False))
        source_email = str(body.get("source_email", "")).strip()
        now = datetime.now(timezone.utc).isoformat()
        doc = {
            "user_id":    g.current_user_id,
            "doc_type":   doc_type,
            "name":       str(body.get("name", "Untitled"))[:160],
            "icon":       str(body.get("icon", ""))[:16],
            "summary":    str(body.get("summary", ""))[:400],
            "ai_created": ai_created,
            "is_draft":   is_draft,
            "status":     "draft" if is_draft else str(body.get("status", "compiled")),
            "data":       data,
            "created_at": now,
            "updated_at": now,
        }
        if source_email:
            doc["source_email"] = source_email[:10000]
        # Set validation_status: AI-filled docs need validation, manual docs are auto-verified
        if not is_draft:
            doc["validation_status"] = "pending" if ai_created else "verified"
        if pdf_file_id:
            doc["pdf_file_id"] = pdf_file_id
        if gcs_object_path:
            doc["gcs_object_path"] = gcs_object_path

        # Add Dispatch and Signatory tracking fields
        doc["unsigned_pdf_url"] = body.get("unsigned_pdf_url") or None
        doc["signed_pdf_url"] = body.get("signed_pdf_url") or None
        doc["docuseal_submission_id"] = body.get("docuseal_submission_id") or None
        doc["signer_email"] = body.get("signer_email") or None

        db = get_db()
        collection = db.drafts if is_draft else db.documents
        result = collection.insert_one(doc)
        doc["_id"] = str(result.inserted_id)
        
        coll_name = "drafts" if is_draft else "documents"
        print(f"  ✅ Document saved to {coll_name}: {doc['_id']} ({doc['doc_type']})")
        return jsonify(doc), 201

    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        if isinstance(e, (ServerSelectionTimeoutError, PyMongoError)):
            return _database_error_response(e)
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/documents/<doc_id>", methods=["GET"])
@require_auth
def api_get_document(doc_id):
    """Return a single document from either drafts or documents collection, with self-healing status sync."""
    try:
        db = get_db()
        oid = ObjectId(doc_id)
        # Check documents first, then drafts
        doc = db.documents.find_one({"_id": oid, "user_id": g.current_user_id})
        if doc:
            doc["is_draft"] = False
        else:
            doc = db.drafts.find_one({"_id": oid, "user_id": g.current_user_id})
            if doc:
                doc["is_draft"] = True
                
        if not doc:
            return jsonify({"error": "Document not found"}), 404
            
        # Self-healing sync for active dispatched files
        if doc.get("status") == "dispatched" and doc.get("docuseal_submission_id"):
            collection = db.documents if not doc["is_draft"] else db.drafts
            doc = _sync_docuseal_submission(doc, db, collection)
            
        return jsonify(_obj_id_to_str(doc))
    except Exception as e:
        if isinstance(e, InvalidId):
            return jsonify({"error": "Invalid document id"}), 400
        if isinstance(e, (ServerSelectionTimeoutError, PyMongoError)):
            return _database_error_response(e)
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/documents/<doc_id>", methods=["PUT"])
@require_auth
def api_update_document(doc_id):
    """Update a document. Handles promotion from drafts to documents if finalized."""
    try:
        body = _json_body()
        oid = ObjectId(doc_id)
        db = get_db()
        
        # Determine current location
        is_in_final = db.documents.find_one({"_id": oid, "user_id": g.current_user_id}) is not None
        
        now = datetime.now(timezone.utc).isoformat()
        update_fields = {"updated_at": now}
        if "data" in body:
            update_fields["data"] = body["data"]
        if "name" in body:
            update_fields["name"] = str(body["name"])[:160]
        if "summary" in body:
            update_fields["summary"] = str(body["summary"])[:400]
        if "pdf_file_id" in body:
            val = str(body["pdf_file_id"]).strip()
            if val:
                update_fields["pdf_file_id"] = val
        if "validation_status" in body:
            val = str(body["validation_status"]).strip()
            if val in ["pending", "verified", "completed"]:
                update_fields["validation_status"] = val
        
        if "status" in body:
            val = str(body["status"]).strip()
            if val in ["draft", "compiled", "dispatched", "signed", "closed", "declined"]:
                update_fields["status"] = val
        if "unsigned_pdf_url" in body:
            update_fields["unsigned_pdf_url"] = body["unsigned_pdf_url"]
        if "signed_pdf_url" in body:
            update_fields["signed_pdf_url"] = body["signed_pdf_url"]
        if "docuseal_submission_id" in body:
            update_fields["docuseal_submission_id"] = body["docuseal_submission_id"]
        if "signer_email" in body:
            update_fields["signer_email"] = body["signer_email"]

        new_is_draft = body.get("is_draft")
        source_email = str(body.get("source_email", "")).strip()
        
        # Logic: Promotion from Draft to Final
        if not is_in_final and new_is_draft == False:
            # Fetch existing draft data to move
            draft_doc = db.drafts.find_one({"_id": oid, "user_id": g.current_user_id})
            if not draft_doc:
                return jsonify({"error": "Draft not found"}), 404
            
            # Merge updates
            draft_doc.update(update_fields)
            draft_doc["is_draft"] = False
            draft_doc["status"] = draft_doc.get("status", "compiled")
            if draft_doc["status"] == "draft":
                draft_doc["status"] = "compiled"
            
            # Set validation_status when finalizing
            if "validation_status" in update_fields:
                draft_doc["validation_status"] = update_fields["validation_status"]
            elif draft_doc.get("ai_created", False):
                draft_doc["validation_status"] = "pending"
            else:
                draft_doc["validation_status"] = "verified"
            
            # Store source email for later validation
            if source_email and not draft_doc.get("source_email"):
                draft_doc["source_email"] = source_email[:10000]
            
            # If finalizing with a pdf_file_id, try to resolve & upload to GCS
            pdf_id = draft_doc.get("pdf_file_id", "")
            if pdf_id and ":" in pdf_id:
                pdf_path, _ = _resolve_generated_pdf({"pdf_file_id": pdf_id})
                if pdf_path and os.path.exists(pdf_path):
                    gcs_path = _upload_to_gcs(pdf_path, g.current_user_id, draft_doc.get("doc_type", ""))
                    if gcs_path:
                        draft_doc["gcs_object_path"] = gcs_path
            
            # Move to documents
            db.documents.insert_one(draft_doc)
            db.drafts.delete_one({"_id": oid})
            print(f"  🚀 Draft promoted to Final: {doc_id} (status: {draft_doc.get('validation_status')})")
            return jsonify(_obj_id_to_str(draft_doc))
        
        # Logic: Demotion from Final (Verified) back to Draft
        # Triggered when user edits a verified trade and clicks "Save Draft"
        if is_in_final and new_is_draft == True:
            # Fetch existing finalized document to move
            final_doc = db.documents.find_one({"_id": oid, "user_id": g.current_user_id})
            if not final_doc:
                return jsonify({"error": "Document not found"}), 404
            
            # Merge updates
            final_doc.update(update_fields)
            final_doc["is_draft"] = True
            final_doc["status"] = "draft"
            
            # Clear stale PDF references — old PDF is now outdated since form data changed
            final_doc.pop("pdf_file_id", None)
            final_doc.pop("gcs_object_path", None)
            
            # Move to drafts
            db.drafts.insert_one(final_doc)
            db.documents.delete_one({"_id": oid})
            print(f"  📝 Verified trade demoted to Draft: {doc_id} (form edited, PDF references cleared)")
            return jsonify(_obj_id_to_str(final_doc))
        
        # Normal update within same collection
        current_coll = db.documents if is_in_final else db.drafts
        update_fields["is_draft"] = bool(new_is_draft) if new_is_draft is not None else (not is_in_final)  # type: ignore[assignment]

        # If already finalized but missing GCS path, upload PDF to cloud storage
        if is_in_final:
            doc = db.documents.find_one({"_id": oid, "user_id": g.current_user_id})
            if doc and not doc.get("gcs_object_path"):
                pdf_id = body.get("pdf_file_id", "") or update_fields.get("pdf_file_id", "")
                if pdf_id and ":" in pdf_id:
                    pdf_path, _ = _resolve_generated_pdf({"pdf_file_id": pdf_id})
                    if pdf_path and os.path.exists(pdf_path):
                        gcs_path = _upload_to_gcs(pdf_path, g.current_user_id, doc.get("doc_type", ""))
                        if gcs_path:
                            update_fields["gcs_object_path"] = gcs_path

        result = current_coll.update_one(
            {"_id": oid, "user_id": g.current_user_id},
            {"$set": update_fields}
        )
        
        if result.matched_count == 0:
            return jsonify({"error": "Document not found"}), 404
            
        return jsonify({"status": "success", "updated_at": now})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/documents/<doc_id>", methods=["DELETE"])
@require_auth
def api_delete_document(doc_id):
    """Delete a document from either collection."""
    try:
        db = get_db()
        oid = ObjectId(doc_id)
        # Try deleting from both
        r1 = db.documents.delete_one({"_id": oid, "user_id": g.current_user_id})
        r2 = db.drafts.delete_one({"_id": oid, "user_id": g.current_user_id})
        
        if r1.deleted_count > 0 or r2.deleted_count > 0:
            print(f"  🗑️ Document deleted: {doc_id}")
            return jsonify({"status": "deleted"})
        return jsonify({"error": "Document not found"}), 404
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500






@app.route("/api/documents/<doc_id>/pdf", methods=["GET"])
@require_auth
def api_serve_document_pdf(doc_id):
    """Serve the stored PDF for a document. Tries temp disk first, then GCS. Handles signed/unsigned types."""
    try:
        db = get_db()
        oid = ObjectId(doc_id)
        doc = db.documents.find_one({"_id": oid, "user_id": g.current_user_id})
        if not doc:
            doc = db.drafts.find_one({"_id": oid, "user_id": g.current_user_id})
        if not doc:
            return jsonify({"error": "Document not found"}), 404

        pdf_type = request.args.get("type", "unsigned")

        # ── Serving Signed PDF ──
        if pdf_type == "signed":
            gcs_signed_path = doc.get("gcs_signed_path", "")
            local_signed_path = os.path.join(TEMP_PDF_DIR, g.current_user_id, "signed", f"{doc_id}_signed.pdf")

            # 1. Try local disk first
            if os.path.exists(local_signed_path):
                filename = f"{doc.get('name', 'document')}_signed.pdf"
                return send_file(local_signed_path, mimetype="application/pdf", as_attachment=True, download_name=filename)

            # 2. Try GCS
            if gcs_signed_path:
                pdf_bytes = _download_from_gcs(gcs_signed_path)
                if pdf_bytes:
                    filename = os.path.basename(gcs_signed_path)
                    return Response(
                        pdf_bytes,
                        mimetype="application/pdf",
                        headers={
                            "Content-Disposition": f"inline; filename={filename}",
                        },
                    )
            # Gracefully fall back to serving the unsigned PDF if no signed copy is found
            # (e.g. for FX NDF trades, or force-closed/un-signed legacy documents)
            print(f"  ⚠️  Signed PDF requested for document {doc_id} but not found. Falling back to unsigned copy.")

        # ── Serving Unsigned PDF (Standard Flow) ──
        file_id = doc.get("pdf_file_id", "")
        if not file_id:
            return jsonify({"error": "No PDF stored for this document"}), 404

        # 1. Try to resolve from temp disk (recently generated PDFs)
        body = {"pdf_file_id": file_id}
        pdf_path, pdf_filename = _resolve_generated_pdf(body)

        if pdf_path and os.path.exists(pdf_path):
            return _send_pdf(pdf_path)

        # 2. Fallback: try GCS (archived PDFs)
        gcs_path = doc.get("gcs_object_path", "")
        if gcs_path:
            gcs_filename = pdf_filename
            if not gcs_filename and ":" in file_id:
                gcs_filename = file_id.split(":", 1)[1]
            if not gcs_filename:
                gcs_filename = os.path.basename(gcs_path)
            if not gcs_filename:
                gcs_filename = "document.pdf"

            pdf_bytes = _download_from_gcs(gcs_path)
            if pdf_bytes:
                return Response(
                    pdf_bytes,
                    mimetype="application/pdf",
                    headers={
                        "Content-Disposition": f"inline; filename={gcs_filename}",
                        "X-TradeDoc-File-Id": file_id,
                    },
                )

            signed_url = _generate_gcs_signed_url(gcs_path)
            if signed_url:
                return jsonify({"signed_url": signed_url, "filename": gcs_filename})

        return jsonify({"error": "PDF file not found on disk or in cloud storage — may have been cleaned up"}), 404
    except Exception as e:
        if isinstance(e, InvalidId):
            return jsonify({"error": "Invalid document id"}), 400
        if isinstance(e, (ServerSelectionTimeoutError, PyMongoError)):
            return _database_error_response(e)
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ═══════════════════════════════════════════
# LANGGRAPH ENDPOINT: AI EXTRACT
#   classify email → extract JSON
# ═══════════════════════════════════════════

@app.route("/ai/extract", methods=["POST"])
@require_auth
@limiter.limit("5 per minute")
def api_ai_extract():
    """
    Accepts email text, runs classify → extract agents.
    Returns classified doc type and extracted JSON.
    """
    try:
        if not os.environ.get("GEMINI_API_KEY"):
            return jsonify({"error": "AI service is not configured. Set GEMINI_API_KEY."}), 503
        body = _json_body()
        email_text = body.get("email_text", "")

        if not email_text.strip():
            return jsonify({"error": "No email text provided"}), 400
            
        MAX_EMAIL_LENGTH = 50_000
        if len(email_text) > MAX_EMAIL_LENGTH:
            return jsonify({"error": f"Email text too long (max {MAX_EMAIL_LENGTH} chars)"}), 400

        print(f"\n{'='*55}")
        print(f"  ▶ AI Extract: classify + extract from email")
        print(f"{'='*55}")

        result = ai_create_graph.invoke({
            "email_text": email_text,
            "mode": "ai_create",
            "model": body.get("model")
        })

        if result.get("error"):
            return jsonify({"error": result["error"]}), 500

        return jsonify({
            "doc_type":         result.get("doc_type", ""),
            "exhibit":          result.get("exhibit", ""),
            "termination_type": result.get("termination_type", ""),
            "model_type":       result.get("model_type", ""),
            "extracted_json":   result.get("extracted_json", {})
        })

    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ═══════════════════════════════════════════
# PDF GENERATION ENDPOINTS (TEMP PDFs only)
# ═══════════════════════════════════════════

def _send_pdf(pdf_path: str):
    """Common helper: stream PDF to client."""
    filename = os.path.basename(pdf_path)
    response = send_file(
        pdf_path, mimetype="application/pdf",
        as_attachment=True, download_name=filename
    )
    job_id = os.path.basename(os.path.dirname(pdf_path))
    response.headers["X-TradeDoc-File-Id"] = _file_id(job_id, filename)
    return response


def _generate_pdf_response(doc_type: str, generator, trade_data: dict):
    if not isinstance(trade_data, dict) or not trade_data:
        return jsonify({"error": "No JSON body provided"}), 400
    if generator is None:
        return jsonify({"error": f"{doc_type.upper()} PDF generator not available — module missing from deployment"}), 503
    job_id, job_dir = _make_job_dir()
    pdf_path = generator(trade_data, job_dir)
    if pdf_path and os.path.exists(pdf_path):
        filename = secure_filename(os.path.basename(pdf_path))
        try:
            get_db().pdf_jobs.insert_one({
                "user_id": _safe_user_id(),
                "job_id": job_id,
                "doc_type": doc_type,
                "filename": filename,
                "path": pdf_path,
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception:
            traceback.print_exc()
        return _send_pdf(pdf_path)
    return jsonify({"error": "PDF compilation failed"}), 500


@app.route("/generate/fx_ndf", methods=["POST"])
@require_auth
def api_generate_fx_ndf():
    """Accept FX NDF trade JSON, generate temp PDF, return it."""
    try:
        trade_data = _json_body()
        print(f"\n{'='*55}\n  ▶ Generating FX NDF PDF...\n{'='*55}")
        return _generate_pdf_response("fx_ndf", _generate_fx_pdf_direct, trade_data)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/generate/irs", methods=["POST"])
@require_auth
def api_generate_irs():
    """Accept IRS trade JSON, generate temp PDF, return it."""
    try:
        trade_data = _json_body()
        print(f"\n{'='*55}\n  ▶ Generating IRS Confirmation PDF...\n{'='*55}")
        return _generate_pdf_response("irs", _generate_irs_pdf_direct, trade_data)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/generate/cds", methods=["POST"])
@require_auth
def api_generate_cds():
    """Accept CDS trade JSON, generate temp PDF, return it."""
    try:
        trade_data = _json_body()
        print(f"\n{'='*55}\n  ▶ Generating CDS Confirmation PDF...\n{'='*55}")
        return _generate_pdf_response("cds", _generate_cds_pdf_direct, trade_data)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/generate/equity_trs", methods=["POST"])
@require_auth
def api_generate_equity_trs():
    """Accept Equity TRS trade JSON (Model I or II), generate temp PDF, return it."""
    try:
        trade_data = _json_body()
        model = trade_data.get("model_type", "I")
        print(f"\n{'='*55}\n  ▶ Generating Equity TRS PDF (Model {model})...\n{'='*55}")
        return _generate_pdf_response("equity_trs", _generate_equity_trs_pdf_direct, trade_data)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ═══════════════════════════════════════════
# WORD CONVERSION ENDPOINT
# ═══════════════════════════════════════════

@app.route("/convert/word", methods=["POST"])
@require_auth
def api_convert_word():
    """Accept a PDF filename, convert to Word (.docx) via Adobe PDF Services API, return it."""
    try:
        body = _json_body()
        pdf_path, pdf_filename = _resolve_generated_pdf(body)

        if not pdf_filename:
            return jsonify({"error": "No PDF filename provided"}), 400
        if not pdf_path:
            return jsonify({"error": f"PDF not found: {pdf_filename}"}), 404

        docx_filename = os.path.splitext(pdf_filename)[0] + ".docx"
        docx_path = os.path.join(os.path.dirname(pdf_path), docx_filename)

        print(f"\n{'='*55}\n  ▶ Converting PDF to Word via Adobe API: {pdf_filename}...\n{'='*55}")
        
        if not ADOBE_AVAILABLE:
            return jsonify({"error": "Adobe PDF Services SDK is not installed or configured."}), 500

        # Re-import inside the guarded block so Pylance knows they're bound
        from adobe.pdfservices.operation.auth.service_principal_credentials import ServicePrincipalCredentials as _SC  # type: ignore[no-redef]
        from adobe.pdfservices.operation.pdf_services import PDFServices as _PS  # type: ignore[no-redef]
        from adobe.pdfservices.operation.pdf_services_media_type import PDFServicesMediaType as _MT  # type: ignore[no-redef]
        from adobe.pdfservices.operation.pdfjobs.jobs.export_pdf_job import ExportPDFJob as _EJ  # type: ignore[no-redef]
        from adobe.pdfservices.operation.pdfjobs.params.export_pdf.export_pdf_params import ExportPDFParams as _EP  # type: ignore[no-redef]
        from adobe.pdfservices.operation.pdfjobs.params.export_pdf.export_pdf_target_format import ExportPDFTargetFormat as _TF  # type: ignore[no-redef]
        from adobe.pdfservices.operation.pdfjobs.params.export_pdf.export_ocr_locale import ExportOCRLocale as _OL  # type: ignore[no-redef]
        from adobe.pdfservices.operation.pdfjobs.result.export_pdf_result import ExportPDFResult as _ER  # type: ignore[no-redef]

        credentials = _SC(
            client_id=os.environ.get("PDF_SERVICES_CLIENT_ID"),
            client_secret=os.environ.get("PDF_SERVICES_CLIENT_SECRET"),
        )
        pdf_services = _PS(credentials=credentials)

        with open(pdf_path, "rb") as f:
            input_stream = f.read()

        asset = pdf_services.upload(input_stream=input_stream, mime_type=_MT.PDF)
        export_params = _EP(
            target_format=_TF.DOCX,
            ocr_lang=_OL.EN_US,
        )
        export_job = _EJ(input_asset=asset, export_pdf_params=export_params)
        location = pdf_services.submit(export_job)
        response = pdf_services.get_job_result(location, _ER)

        result_asset = response.get_result().get_asset()
        stream_asset = pdf_services.get_content(result_asset)

        with open(docx_path, "wb") as out:
            out.write(stream_asset.get_input_stream())

        if os.path.exists(docx_path):
            print(f"  ✅ Word file created: {docx_filename}")
            return send_file(
                docx_path,
                mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                as_attachment=True,
                download_name=docx_filename
            )
        return jsonify({"error": "Word conversion failed"}), 500

    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ═══════════════════════════════════════════
# LANGGRAPH ENDPOINT: VALIDATE
# ═══════════════════════════════════════════

@app.route("/validate", methods=["POST"])
@require_auth
@limiter.limit("5 per minute")
def api_validate():
    """
    Accepts email_text + pdf_filename, runs validation agent.
    Compares the generated PDF against the original email.
    If doc_id provided, marks the document as verified after successful validation.
    Supports PDFs from temp disk (pdf_file_id) or GCS (gcs_object_path).
    """
    try:
        if not os.environ.get("GEMINI_API_KEY"):
            return jsonify({"error": "AI service is not configured. Set GEMINI_API_KEY."}), 503
        body = _json_body()
        email_text = body.get("email_text", "")
        pdf_path, pdf_filename = _resolve_generated_pdf(body)

        # If not found on temp disk and gcs_object_path is provided, download from GCS
        if (not pdf_path or not os.path.exists(pdf_path)) and body.get("gcs_object_path"):
            gcs_path = body["gcs_object_path"]
            pdf_bytes = _download_from_gcs(gcs_path)
            if pdf_bytes:
                # Save to a temp location for the validation agent to read
                import tempfile
                user_id = _safe_user_id()
                tmp_dir = os.path.join(tempfile.gettempdir(), "tradedoc_validate", user_id)
                os.makedirs(tmp_dir, exist_ok=True)
                pdf_filename = secure_filename(body.get("pdf_filename", "confirmation.pdf"))
                if not pdf_filename.lower().endswith(".pdf"):
                    pdf_filename += ".pdf"
                pdf_path = os.path.join(tmp_dir, pdf_filename)
                with open(pdf_path, "wb") as f:
                    f.write(pdf_bytes)
                print(f"  📥 Downloaded PDF from GCS for validation: {pdf_filename}")

        if not pdf_filename:
            return jsonify({"error": "No PDF filename provided"}), 400
        if not email_text.strip():
            return jsonify({"error": "No email text provided for validation"}), 400
        if not pdf_path or not os.path.exists(pdf_path):
            return jsonify({"error": f"PDF not found: {pdf_filename}"}), 404

        print(f"\n{'='*55}\n  ▶ Validating PDF: {pdf_filename} against email...\n{'='*55}")

        result = validation_graph.invoke({
            "email_text": email_text,
            "pdf_path": pdf_path,
            "mode": "validate",
            "model": body.get("model")
        })

        if result.get("error"):
            return jsonify({"error": result["error"]}), 500

        # Mark document as verified + store validation report if doc_id provided
        doc_id = body.get("doc_id", "").strip()
        validation_report_text = result.get("validation_report", "")
        if doc_id:
            try:
                db = get_db()
                oid = ObjectId(doc_id)
                db.documents.update_one(
                    {"_id": oid, "user_id": g.current_user_id},
                    {"$set": {
                        "validation_status": "verified",
                        "validation_report": validation_report_text,
                        "updated_at": _iso_now()
                    }}
                )
                print(f"  ✅ Document {doc_id} marked as verified with stored validation report")
            except Exception:
                pass  # Non-critical — validation report still returned

        return jsonify({
            "validation_report": validation_report_text or "No report generated"
        })

    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ═══════════════════════════════════════════
# VALIDATION REPORT RETRIEVAL ENDPOINT
# ═══════════════════════════════════════════

@app.route("/api/documents/<doc_id>/validation", methods=["GET"])
@require_auth
def api_get_validation_report(doc_id):
    """Retrieve the stored validation report for a document."""
    try:
        db = get_db()
        oid = ObjectId(doc_id)
        doc = db.documents.find_one({"_id": oid, "user_id": g.current_user_id})
        if not doc:
            return jsonify({"error": "Document not found"}), 404
        report = doc.get("validation_report", "")
        return jsonify({
            "validation_report": report or "",
            "has_report": bool(report and str(report).strip()),
            "validation_status": doc.get("validation_status", "pending")
        })
    except InvalidId:
        return jsonify({"error": "Invalid document id"}), 400
    except Exception as e:
        if isinstance(e, (ServerSelectionTimeoutError, PyMongoError)):
            return _database_error_response(e)
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
# ═══════════════════════════════════════════
# EMAIL & SIGNATORY INTEGRATIONS (RESEND & DOCUSEAL)
# ═══════════════════════════════════════════

def send_email_via_resend(to_email, subject, html_content, attachment_bytes=None, attachment_name=None):
    """
    Sends an email using the Resend API.
    Optionally attaches a PDF document.
    """
    import base64
    import requests

    if not RESEND_API_KEY:
        print("  ⚠️  RESEND_API_KEY is not set. Skipping email.")
        return False
    
    url = "https://api.resend.com/emails"
    headers = {
        "Authorization": f"Bearer {RESEND_API_KEY}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "from": "TradeDoc AI <onboarding@resend.dev>",  # Sandbox testing domain
        "to": [to_email],
        "subject": subject,
        "html": html_content
    }
    
    if attachment_bytes and attachment_name:
        encoded_content = base64.b64encode(attachment_bytes).decode("utf-8")
        payload["attachments"] = [
            {
                "content": encoded_content,
                "filename": attachment_name
            }
        ]
        
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=15)
        if response.status_code in [200, 201]:
            print(f"  ✉️  Email successfully sent via Resend to {to_email}")
            return True
        else:
            print(f"  ⚠️  Resend Email failed: {response.status_code} - {response.text}")
            return False
    except Exception as e:
        print(f"  ⚠️  Error in Resend Helper: {e}")
        return False


def create_docuseal_template(pdf_bytes, filename, trade_name):
    """
    Uploads a PDF to DocuSeal to create a new template.
    Returns the template ID and editor/preview URL.
    """
    import base64
    import requests

    if not DOCUSEAL_API_KEY:
        print("  ⚠️  DOCUSEAL_API_KEY is not set.")
        return None
        
    url = "https://api.docuseal.co/templates/pdf"
    headers = {
        "X-Auth-Token": DOCUSEAL_API_KEY,
        "Content-Type": "application/json"
    }
    
    encoded_file = base64.b64encode(pdf_bytes).decode("utf-8")
    payload = {
        "name": trade_name or "Trade Confirmation",
        "documents": [
            {
                "file": encoded_file,
                "name": filename
            }
        ],
        "submitters": [
            {
                "role": "Sender"
            },
            {
                "role": "Counterparty"
            }
        ]
    }
    
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=20)
        if response.status_code in [200, 201]:
            data = response.json()
            print(f"  📝 DocuSeal Template created: {data.get('id')}")
            return data
        else:
            print(f"  ⚠️  DocuSeal template creation failed: {response.status_code} - {response.text}")
            return None
    except Exception as e:
        print(f"  ⚠️  Error in DocuSeal Template Helper: {e}")
        return None


def create_docuseal_submission(template_id, sender_email, signer_email):
    """
    Creates a submission for a template, assigning roles for signing.
    """
    import requests

    if not DOCUSEAL_API_KEY:
        return None
        
    url = "https://api.docuseal.co/submissions"
    headers = {
        "X-Auth-Token": DOCUSEAL_API_KEY,
        "Content-Type": "application/json"
    }
    
    payload = {
        "template_id": template_id,
        "send_email": True,
        "submitters": [
            {
                "role": "Sender",
                "email": sender_email
            },
            {
                "role": "Counterparty",
                "email": signer_email
            }
        ]
    }
    
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=20)
        if response.status_code in [200, 201]:
            data = response.json()
            print(f"  ✍️  DocuSeal Submission created: {response.status_code}")
            return data
        else:
            print(f"  ⚠️  DocuSeal submission failed: {response.status_code} - {response.text}")
            return None
    except Exception as e:
        print(f"  ⚠️  Error in DocuSeal Submission Helper: {e}")
        return None


def sign_jwt_hs256(payload: dict, key: str) -> str:
    import json
    import base64
    import hmac
    import hashlib

    def base64url_encode(b: bytes) -> str:
        return base64.urlsafe_b64encode(b).decode('utf-8').replace('=', '')

    header = {"alg": "HS256", "typ": "JWT"}
    
    header_part = base64url_encode(json.dumps(header, separators=(',', ':')).encode('utf-8'))
    payload_part = base64url_encode(json.dumps(payload, separators=(',', ':')).encode('utf-8'))
    
    message = f"{header_part}.{payload_part}"
    
    signature = hmac.new(key.encode('utf-8'), message.encode('utf-8'), digestmod=hashlib.sha256).digest()
    signature_part = base64url_encode(signature)
    
    return f"{message}.{signature_part}"


@app.route("/api/documents/<doc_id>/builder-token", methods=["GET"])
@require_auth
def api_get_builder_token(doc_id):
    """
    Get a secure JWT token for the DocuSeal Template Builder.
    If the template is not already created on DocuSeal, it compiles and uploads it first.
    """
    try:
        db = get_db()
        oid = ObjectId(doc_id)
        
        doc = db.documents.find_one({"_id": oid, "user_id": g.current_user_id})
        if not doc:
            doc = db.drafts.find_one({"_id": oid, "user_id": g.current_user_id})
            
        if not doc:
            return jsonify({"error": "Document not found"}), 404
            
        template_id = doc.get("docuseal_template_id")
        
        # If template is not created yet, upload the compiled PDF to DocuSeal first
        if not template_id:
            file_id = doc.get("pdf_file_id", "")
            pdf_bytes = None
            pdf_filename = None
            
            if file_id:
                pdf_path, pdf_filename = _resolve_generated_pdf({"pdf_file_id": file_id})
                if pdf_path and os.path.exists(pdf_path):
                    with open(pdf_path, "rb") as f:
                        pdf_bytes = f.read()
                        
            if not pdf_bytes:
                gcs_path = doc.get("gcs_object_path", "")
                if gcs_path:
                    pdf_bytes = _download_from_gcs(gcs_path)
                    pdf_filename = f"{doc_id}_unsigned.pdf"
                    
            if not pdf_bytes:
                return jsonify({"error": "Compiled PDF file could not be found. Please generate the PDF first."}), 404
                
            template = create_docuseal_template(pdf_bytes, pdf_filename or "trade.pdf", doc.get("name"))
            if not template:
                return jsonify({"error": "Failed to upload document to DocuSeal"}), 500
                
            template_id = template.get("id")
            
            # Save the template ID in MongoDB
            collection = db.documents if db.documents.find_one({"_id": oid}) else db.drafts
            collection.update_one({"_id": oid}, {"$set": {"docuseal_template_id": template_id}})
            
        # Generate the secure JWT token signed with DOCUSEAL_API_KEY
        sender_email = g.current_user.get("email") or "admin@company.com"
        payload = {
            "user_email": sender_email,
            "integration_email": sender_email,
            "external_id": str(doc_id),
            "name": doc.get("name", "Trade Confirmation"),
            "template_id": int(template_id)
        }
        
        token = sign_jwt_hs256(payload, DOCUSEAL_API_KEY)
        
        return jsonify({
            "status": "success",
            "token": token,
            "template_id": template_id
        })
        
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/documents/<doc_id>/sign-local", methods=["POST"])
@require_auth
def api_sign_document_local(doc_id):
    """
    Stamps the Banker's drawn signature and text fields onto the trade PDF locally using PyMuPDF.
    Saves the partially signed PDF and clears docuseal_template_id to trigger a fresh template upload.
    """
    try:
        body = _json_body()
        
        signatures = body.get("signatures", [])
        text_fields = body.get("text_fields", [])
        global_page_num = int(body.get("page_num", 0))
        
        # Backward compatibility fallback for single signature properties
        if not signatures and body.get("signature_base64"):
            sig_base64 = str(body.get("signature_base64", ""))
            signatures = [{
                "page_num": global_page_num,
                "x_pct": float(body.get("sig_x_pct", 0.0)),
                "y_pct": float(body.get("sig_y_pct", 0.0)),
                "w_pct": float(body.get("sig_w_pct", 0.0)),
                "h_pct": float(body.get("sig_h_pct", 0.0)),
                "base64": sig_base64
            }]
            
        if not signatures and not body.get("signature_base64"):
            return jsonify({"error": "Signature data is required"}), 400
            
        db = get_db()
        oid = ObjectId(doc_id)
        
        doc_record = db.documents.find_one({"_id": oid, "user_id": g.current_user_id})
        collection = db.documents
        if not doc_record:
            doc_record = db.drafts.find_one({"_id": oid, "user_id": g.current_user_id})
            collection = db.drafts
            
        if not doc_record:
            return jsonify({"error": "Document not found"}), 404
            
        # Resolve original PDF file path
        file_id = doc_record.get("pdf_file_id", "")
        if not file_id:
            return jsonify({"error": "Compiled PDF file not found. Please compile the PDF first."}), 404
            
        pdf_path, pdf_filename = _resolve_generated_pdf({"pdf_file_id": file_id})
        if not pdf_path or not os.path.exists(pdf_path):
            # Try GCS fallback
            gcs_path = doc_record.get("gcs_object_path", "")
            if gcs_path:
                pdf_bytes = _download_from_gcs(gcs_path)
                if pdf_bytes:
                    # Write to local disk to stamp it
                    os.makedirs(os.path.dirname(pdf_path), exist_ok=True)
                    with open(pdf_path, "wb") as f:
                        f.write(pdf_bytes)
            
        # Keep a backup of the original unsigned PDF so we can re-stamp from clean copy if the user adjusts layout!
        unsigned_backup = pdf_path + ".unsigned"
        if not os.path.exists(unsigned_backup):
            shutil.copy2(pdf_path, unsigned_backup)
        else:
            # Restore the clean unsigned PDF from backup before applying new stamp positions
            shutil.copy2(unsigned_backup, pdf_path)

        # Open PDF using PyMuPDF (fitz)
        import fitz
        doc_pdf = fitz.open(pdf_path)
        num_pages = len(doc_pdf)
        
        # Validate all page numbers beforehand
        for sig in signatures:
            p_num = int(sig.get("page_num", 0))
            if p_num < 0 or p_num >= num_pages:
                doc_pdf.close()
                return jsonify({"error": f"Invalid signature page number {p_num}. Document has {num_pages} pages."}), 400
                
        for t in text_fields:
            p_num = int(t.get("page_num", global_page_num))
            if p_num < 0 or p_num >= num_pages:
                doc_pdf.close()
                return jsonify({"error": f"Invalid text field page number {p_num}. Document has {num_pages} pages."}), 400
                
        # 1. Overlay Signature Images across respective pages
        for sig in signatures:
            p_num = int(sig.get("page_num", 0))
            sig_base64 = str(sig.get("base64", ""))
            if not sig_base64:
                continue
                
            if "base64," in sig_base64:
                sig_base64 = sig_base64.split("base64,", 1)[1]
            
            try:
                signature_bytes = base64.b64decode(sig_base64)
            except Exception as e:
                doc_pdf.close()
                return jsonify({"error": f"Invalid signature base64 encoding: {str(e)}"}), 400
                
            page = doc_pdf[p_num]
            page_w = page.rect.width
            page_h = page.rect.height
            
            sig_x = float(sig.get("x_pct", 0.0)) * page_w
            sig_y = float(sig.get("y_pct", 0.0)) * page_h
            sig_w = float(sig.get("w_pct", 0.0)) * page_w
            sig_h = float(sig.get("h_pct", 0.0)) * page_h
            
            sig_rect = fitz.Rect(sig_x, sig_y, sig_x + sig_w, sig_y + sig_h)
            page.insert_image(sig_rect, stream=signature_bytes)
        
        # 2. Overlay Text Fields across respective pages
        for t in text_fields:
            text = str(t.get("text", "")).strip()
            if not text:
                continue
                
            p_num = int(t.get("page_num", global_page_num))
            x_pct = float(t.get("x_pct", 0.0))
            y_pct = float(t.get("y_pct", 0.0))
            f_size = int(t.get("fontSize", 10))
            
            page = doc_pdf[p_num]
            page_w = page.rect.width
            page_h = page.rect.height
            
            # Map percentages to fitz coordinates
            tx = x_pct * page_w
            ty = y_pct * page_h
            # In PyMuPDF, insert_text needs baseline coordinate, ty is the top, so we shift down slightly for baseline
            page.insert_text(fitz.Point(tx, ty + f_size - 1), text, fontsize=f_size, fontname="helv", color=(0.1, 0.1, 0.1))
            
        # Save modifications to a temp file first
        temp_path = pdf_path + ".signed"
        doc_pdf.save(temp_path)
        doc_pdf.close()
        
        # Replace the original PDF with the stamped PDF
        os.replace(temp_path, pdf_path)
        
        # 3. If GCS is enabled, upload the partially signed PDF to GCS to overwrite the unsigned one
        gcs_object_path = doc_record.get("gcs_object_path", "")
        if GCS_AVAILABLE and GCS_BUCKET_NAME and gcs_object_path:
            try:
                client = _storage_client()
                if client:
                    bucket = client.bucket(GCS_BUCKET_NAME)
                    blob = bucket.blob(gcs_object_path)
                    with open(pdf_path, "rb") as f:
                        blob.upload_from_string(f.read(), content_type="application/pdf")
                    print(f"  ☁️  Partially signed PDF synced to GCS: {gcs_object_path}")
            except Exception as e:
                print(f"  ⚠️  Error uploading stamped PDF to GCS: {e}")
                
        # 4. Save updates in MongoDB:
        # Clear docuseal_template_id to trigger a fresh template upload with the signed PDF!
        # Mark banker_signed as True
        now = datetime.now(timezone.utc).isoformat()
        collection.update_one(
            {"_id": oid},
            {"$set": {
                "banker_signed": True,
                "docuseal_template_id": None,
                "docuseal_submission_id": None,
                "updated_at": now
            }}
        )
        
        print(f"  ✍️  Document {doc_id} successfully signed locally by banker!")
        return jsonify({
            "status": "success",
            "message": "Signature applied successfully",
            "banker_signed": True
        })
        
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/documents/<doc_id>/dispatch", methods=["POST"])
@require_auth
def api_dispatch_document(doc_id):
    """
    Dispatch a document.
    For FX: Emails the PDF directly to counterparty.
    For IRS/CDS/TRS: Uploads to DocuSeal, creates signature links, and emails them.
    """
    try:
        body = _json_body()
        signer_email = str(body.get("signer_email", "")).strip()
        signer_name = str(body.get("signer_name", "")).strip()
        custom_message = str(body.get("message", "")).strip()
        
        if not signer_email:
            return jsonify({"error": "Signer email is required"}), 400
            
        db = get_db()
        oid = ObjectId(doc_id)
        
        doc = db.documents.find_one({"_id": oid, "user_id": g.current_user_id})
        if not doc:
            doc = db.drafts.find_one({"_id": oid, "user_id": g.current_user_id})
            
        if not doc:
            return jsonify({"error": "Document not found"}), 404
            
        doc_type = doc["doc_type"]
        file_id = doc.get("pdf_file_id", "")
        
        pdf_path = None
        pdf_filename = None
        pdf_bytes = None
        
        if file_id:
            pdf_path, pdf_filename = _resolve_generated_pdf({"pdf_file_id": file_id})
            if pdf_path and os.path.exists(pdf_path):
                with open(pdf_path, "rb") as f:
                    pdf_bytes = f.read()
                    
        if not pdf_bytes:
            gcs_path = doc.get("gcs_object_path", "")
            if gcs_path:
                pdf_bytes = _download_from_gcs(gcs_path)
                pdf_filename = f"{doc_id}_unsigned.pdf"
                
        if not pdf_bytes:
            return jsonify({"error": "Compiled PDF file could not be found. Please generate the PDF first."}), 404
            
        # ── FX NDF Flow (Direct Email, No Signatures) ──
        if doc_type == "fx_ndf":
            subject = f"Trade Confirmation: {doc.get('name', 'FX NDF Trade')}"
            html_content = f"""
            <h3>Trade Confirmation Details</h3>
            <p>Hi {signer_name or 'there'},</p>
            <p>Please find attached the compiled Trade Confirmation for <strong>{doc.get('name')}</strong>.</p>
            {f'<p>Message from sender: "{custom_message}"</p>' if custom_message else ''}
            <br/>
            <p>Best regards,<br/>TradeDoc AI team</p>
            """
            
            sent = send_email_via_resend(signer_email, subject, html_content, pdf_bytes, pdf_filename)
            if not sent:
                return jsonify({"error": "Failed to send email via Resend"}), 500
                
            now = datetime.now(timezone.utc).isoformat()
            update_fields = {
                "status": "closed",
                "signer_email": signer_email,
                "unsigned_pdf_url": f"/api/documents/{doc_id}/pdf",
                "updated_at": now
            }
            collection = db.documents if db.documents.find_one({"_id": oid}) else db.drafts
            collection.update_one({"_id": oid}, {"$set": update_fields})
            
            return jsonify({
                "status": "success",
                "message": "FX Trade Confirmation emailed successfully",
                "doc_status": "closed"
            })
            
        # ── IRS/CDS/TRS Flow (DocuSeal Signature Requests) ──
        else:
            template_id = doc.get("docuseal_template_id")
            if not template_id:
                template = create_docuseal_template(pdf_bytes, pdf_filename or "trade.pdf", doc.get("name"))
                if not template:
                    return jsonify({"error": "Failed to upload document to DocuSeal"}), 500
                template_id = template.get("id")
                collection = db.documents if db.documents.find_one({"_id": oid}) else db.drafts
                collection.update_one({"_id": oid}, {"$set": {"docuseal_template_id": template_id}})
            
            sender_email = g.current_user.get("email")
            submission = create_docuseal_submission(template_id, sender_email, signer_email)
            if not submission:
                return jsonify({"error": "Failed to create DocuSeal signature request"}), 500
                
            submitters = submission if isinstance(submission, list) else submission.get("submitters", [])
            sender_sign_url = None
            counterparty_sign_url = None
            submission_id = None
            
            for s in submitters:
                submission_id = s.get("submission_id") or submission_id
                role = s.get("role", "").lower()
                slug = s.get("slug")
                sign_url = f"https://docuseal.com/d/{slug}" if slug else None
                
                if "sender" in role or "first" in role:
                    sender_sign_url = sign_url
                elif "counterparty" in role or "receiver" in role or "second" in role:
                    counterparty_sign_url = sign_url
                    
            if submitters and not submission_id:
                submission_id = submitters[0].get("submission_id")
                
            if not submission_id:
                submission_id = submission.get("id") if isinstance(submission, dict) else None
                
            now = datetime.now(timezone.utc).isoformat()
            update_fields = {
                "status": "dispatched",
                "signer_email": signer_email,
                "docuseal_submission_id": str(submission_id) if submission_id else None,
                "unsigned_pdf_url": f"/api/documents/{doc_id}/pdf",
                "updated_at": now
            }
            collection = db.documents if db.documents.find_one({"_id": oid}) else db.drafts
            collection.update_one({"_id": oid}, {"$set": update_fields})
            
            return jsonify({
                "status": "success",
                "message": "Signature request dispatched successfully",
                "doc_status": "dispatched",
                "docuseal_submission_id": submission_id,
                "sender_sign_url": sender_sign_url,
                "counterparty_sign_url": counterparty_sign_url
            })
            
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/webhooks/docuseal", methods=["POST"])
def api_docuseal_webhook():
    """
    Webhook endpoint for DocuSeal callbacks.
    Updates document status to 'signed' and archives the completed PDF in GCS.
    """
    import requests
    try:
        payload = request.get_json(silent=True) or {}
        event = payload.get("event")
        print(f"  🔔 DocuSeal Webhook received: {event}")
        
        if event == "submission.completed":
            data = payload.get("data", {})
            submission_id = data.get("id")
            
            db = get_db()
            doc = db.documents.find_one({"docuseal_submission_id": str(submission_id)})
            if not doc:
                doc = db.drafts.find_one({"docuseal_submission_id": str(submission_id)})
                
            if not doc:
                print(f"  ⚠️  No document found for DocuSeal submission ID: {submission_id}")
                return jsonify({"status": "ignored", "message": "Submission not tracked"}), 200
                
            documents = data.get("documents", [])
            if not documents:
                print("  ⚠️  No documents in submission completion payload")
                return jsonify({"error": "No documents found"}), 400
                
            completed_pdf_url = documents[0].get("url")
            if not completed_pdf_url:
                print("  ⚠️  No completed PDF URL in payload")
                return jsonify({"error": "No URL found"}), 400
                
            headers = {"X-Auth-Token": DOCUSEAL_API_KEY}
            pdf_res = requests.get(completed_pdf_url, headers=headers, timeout=30)
            if pdf_res.status_code != 200:
                print(f"  ⚠️  Failed to download signed PDF: {pdf_res.status_code}")
                return jsonify({"error": "Failed to download signed PDF"}), 500
                
            signed_pdf_bytes = pdf_res.content
            doc_id = str(doc["_id"])
            user_id = str(doc["user_id"])
            doc_type = doc["doc_type"]
            
            gcs_signed_path = None
            if GCS_AVAILABLE and GCS_BUCKET_NAME:
                try:
                    client = _storage_client()
                    if client:
                        bucket = client.bucket(GCS_BUCKET_NAME)
                        object_path = f"{user_id}/{doc_type}/{doc_id}_signed.pdf"
                        blob = bucket.blob(object_path)
                        blob.upload_from_string(signed_pdf_bytes, content_type="application/pdf")
                        gcs_signed_path = object_path
                        print(f"  ☁️  Signed PDF saved to GCS: gs://{GCS_BUCKET_NAME}/{object_path}")
                except Exception as e:
                    print(f"  ⚠️  Error saving signed PDF to GCS: {e}")
                    
            local_signed_dir = os.path.join(TEMP_PDF_DIR, user_id, "signed")
            os.makedirs(local_signed_dir, exist_ok=True)
            local_signed_path = os.path.join(local_signed_dir, f"{doc_id}_signed.pdf")
            with open(local_signed_path, "wb") as f:
                f.write(signed_pdf_bytes)
                
            now = datetime.now(timezone.utc).isoformat()
            update_fields = {
                "status": "closed",
                "signed_pdf_url": f"/api/documents/{doc_id}/pdf?type=signed",
                "updated_at": now
            }
            if gcs_signed_path:
                update_fields["gcs_signed_path"] = gcs_signed_path
                
            collection = db.documents if db.documents.find_one({"_id": ObjectId(doc_id)}) else db.drafts
            collection.update_one({"_id": ObjectId(doc_id)}, {"$set": update_fields})
            
            print(f"  ✅ Document {doc_id} successfully transitioned to 'closed' status!")
            
            signer_email = doc.get("signer_email")
            if signer_email:
                sender = db.users.find_one({"_id": ObjectId(user_id)})
                sender_email = sender.get("email") if sender else None
                
                subject = f"Executed Trade Confirmation: {doc.get('name', 'Trade')}"
                html_content = f"""
                <h3>Your Trade document is fully executed!</h3>
                <p>Hi,</p>
                <p>The trade document <strong>{doc.get('name')}</strong> has been successfully signed by both parties.</p>
                <p>We have attached the final executed PDF containing the electronic signatures and date/time stamps for your records.</p>
                <br/>
                <p>Best regards,<br/>TradeDoc AI team</p>
                """
                if sender_email:
                    send_email_via_resend(sender_email, subject, html_content, signed_pdf_bytes, f"{doc.get('name', 'trade')}_signed.pdf")
                send_email_via_resend(signer_email, subject, html_content, signed_pdf_bytes, f"{doc.get('name', 'trade')}_signed.pdf")
            
        return jsonify({"status": "received"}), 200
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/documents/<doc_id>/close", methods=["POST"])
@require_auth
def api_close_document(doc_id):
    """
    Close a document. Promotes status to 'closed'.
    """
    try:
        db = get_db()
        oid = ObjectId(doc_id)
        
        doc = db.documents.find_one({"_id": oid, "user_id": g.current_user_id})
        collection = db.documents
        if not doc:
            doc = db.drafts.find_one({"_id": oid, "user_id": g.current_user_id})
            collection = db.drafts
            
        if not doc:
            return jsonify({"error": "Document not found"}), 404
            
        current_status = doc.get("status")
        if current_status not in ["signed", "dispatched", "compiled"]:
            return jsonify({"error": f"Cannot close document in '{current_status}' status"}), 400
            
        now = datetime.now(timezone.utc).isoformat()
        collection.update_one(
            {"_id": oid},
            {"$set": {
                "status": "closed",
                "updated_at": now
            }}
        )
        
        print(f"  🔒 Document {doc_id} successfully closed/archived.")
        return jsonify({
            "status": "success",
            "message": "Document successfully closed and archived",
            "doc_status": "closed"
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ═══════════════════════════════════════════
# BOOT
# ═══════════════════════════════════════════

if __name__ == "__main__":
    import sys
    # Ensure stdout can handle UTF-8 on Windows terminals
    if sys.stdout.encoding and sys.stdout.encoding.lower() in ('cp1252', 'ascii'):
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

    print()
    print("=" * 55)
    print("  TradeDoc AI Server -- LangGraph Edition")
    print("=" * 55)
    PORT = int(os.environ.get("PORT", "5055"))
    print(f"  UI:              http://localhost:{PORT}")
    print(f"  AI Extract:      POST /ai/extract")
    print(f"  FX NDF PDF:      POST /generate/fx_ndf")
    print(f"  IRS PDF:         POST /generate/irs")
    print(f"  CDS PDF:         POST /generate/cds")
    print(f"  Equity TRS PDF:  POST /generate/equity_trs")
    print(f"  To Word:         POST /convert/word")
    print(f"  Validate:        POST /validate")
    print(f"  Save Doc:        POST /api/documents")
    print(f"  List Docs:       GET  /api/documents")
    print(f"  Get Doc:         GET  /api/documents/<id>")
    print(f"  Update Doc:      PUT  /api/documents/<id>")
    print(f"  Delete Doc:      DEL  /api/documents/<id>")
    print(f"  Temp PDF dir:    {TEMP_PDF_DIR}")
    print("=" * 55)
    print()

    try:
        get_db().command("ping")
        print("  ✅ MongoDB connected successfully")
    except Exception as e:
        print(f"  ⚠️  MongoDB not available: {e}")
        print("  ℹ️  Document saving/loading will fail")
        
    DEBUG = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=PORT, debug=DEBUG)
