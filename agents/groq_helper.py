"""
Groq API Helper
===================
Shared helper for calling Groq cloud models.
Provides low-latency text generation and SSE streaming.
Includes automatic key rotation for 5+ API keys to bypass rate limits.
"""

import os
import time
from pathlib import Path
from dotenv import load_dotenv
from groq import Groq

# Load .env from project root
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_PROJECT_ROOT / ".env")

MODEL = os.getenv("GROQ_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct")
FALLBACK_MODEL = "llama-3.3-70b-specdec"  # Standard highly capable Groq model

# Parse separate keys (e.g. GROQ_API_KEY_1, GROQ_API_KEY_2, etc.)
_KEYS = []
_i = 1
while True:
    _key = os.getenv(f"GROQ_API_KEY_{_i}")
    if not _key:
        break
    _KEYS.append(_key.strip())
    _i += 1

# Fallback to comma-separated GROQ_API_KEYS if separate keys are not defined
if not _KEYS:
    _KEYS_STRING = os.getenv("GROQ_API_KEYS", "")
    _KEYS = [k.strip() for k in _KEYS_STRING.split(",") if k.strip()]

# Fallback: if keys are not in the array but the old key is present
if not _KEYS:
    _SINGLE_KEY = os.getenv("GROQ_API_KEY", "")
    if _SINGLE_KEY:
        _KEYS = [_SINGLE_KEY]

# Global state to track key indexing
_current_key_idx = 0
_clients = {}  # Cache Groq clients by API key to avoid re-init overheads


def _get_client_for_current_key() -> tuple[Groq, int]:
    """Retrieve the Groq client for the current index, rotating if no keys exist."""
    global _current_key_idx
    if not _KEYS:
        raise RuntimeError("No Groq API Keys are configured in .env under GROQ_API_KEY_X, GROQ_API_KEYS, or GROQ_API_KEY.")
    
    current_key = _KEYS[_current_key_idx]
    if current_key not in _clients:
        _clients[current_key] = Groq(api_key=current_key)
    
    return _clients[current_key], _current_key_idx


def rotate_groq_key():
    """Manually rotate the global index to the next configured API key."""
    global _current_key_idx
    if not _KEYS:
        return
    old_idx = _current_key_idx
    _current_key_idx = (_current_key_idx + 1) % len(_KEYS)
    print(f"  🔄 Groq Rotation: Key index rotated from {old_idx} to {_current_key_idx} (Total keys: {len(_KEYS)})")


def call_groq(prompt: str, max_retries: int = 5, model_name: str | None = None, system_instruction: str | None = None) -> str:
    """
    Call Groq for text-completion tasks.
    Returns the response text.
    Includes auto-healing key rotation: if a key fails (due to 429 Rate Limits,
    quota issues, etc.), it immediately rotates to the next key and retries seamlessly.
    """
    primary_model = model_name or MODEL
    fallback_model = FALLBACK_MODEL if primary_model != FALLBACK_MODEL else "llama-3.1-8b-instant"

    for attempt in range(max_retries):
        # Retrieve client for the current rotated key
        client, key_idx = _get_client_for_current_key()
        
        # Decide model to use
        use_model = primary_model
        if attempt >= 2 and fallback_model:
            use_model = fallback_model

        try:
            messages = []
            if system_instruction:
                messages.append({"role": "system", "content": system_instruction})
            messages.append({"role": "user", "content": prompt})

            response = client.chat.completions.create(
                model=use_model,
                messages=messages
            )
            return (response.choices[0].message.content or "").strip()
        except Exception as e:
            error_str = str(e).upper()
            print(f"  ⚠️ Groq attempt {attempt+1}/{max_retries} failed on Key Index {key_idx} ({use_model}): {error_str}")
            
            # Check if this error is related to rate limits or key quota limits
            is_rate_limited = any(msg in error_str for msg in ["429", "RATE_LIMIT", "RESOURCE_EXHAUSTED", "LIMIT_EXCEEDED", "QUOTA"])
            is_model_error = "NOT FOUND" in error_str or "MODEL" in error_str or "400" in error_str or "404" in error_str
            is_retryable = is_rate_limited or is_model_error or any(msg in error_str for msg in ["503", "500", "UNAVAILABLE", "SERVICE_UNAVAILABLE", "DEADLINE_EXCEEDED"])
            
            if is_retryable and attempt < max_retries - 1:
                if is_rate_limited:
                    print(f"  ⚡ Rate limit detected on Key Index {key_idx}! Performing self-healing key rotation...")
                    rotate_groq_key()
                    # Retry immediately with the rotated key, no waiting
                    continue
                
                # For other errors, sleep slightly
                wait = 0.5 if is_model_error else (attempt + 1) * 1.5
                time.sleep(wait)
            else:
                print(f"  ❌ Groq Rotation Failure: All attempts or keys exhausted.")
                raise e

    raise Exception("Groq API could not fulfill the request after all rotation attempts.")


def call_groq_stream(prompt: str, model_name: str | None = None, system_instruction: str | None = None, max_retries: int = 5):
    """
    Call Groq with streaming support. Yields buffered text chunks.
    Includes auto-healing key rotation: if the connection fails (due to 429 Rate Limits,
    quota issues, etc.), it immediately rotates to the next key and retries seamlessly.
    """
    primary_model = model_name or MODEL
    fallback_model = FALLBACK_MODEL if primary_model != FALLBACK_MODEL else "llama-3.1-8b-instant"

    stream = None
    for attempt in range(max_retries):
        client, key_idx = _get_client_for_current_key()
        use_model = primary_model
        if attempt >= 2 and fallback_model:
            use_model = fallback_model

        try:
            messages = []
            if system_instruction:
                messages.append({"role": "system", "content": system_instruction})
            messages.append({"role": "user", "content": prompt})

            stream = client.chat.completions.create(
                model=use_model,
                messages=messages,
                stream=True
            )
            break
        except Exception as e:
            error_str = str(e).upper()
            print(f"  ⚠️ Groq Stream connection attempt {attempt+1}/{max_retries} failed on Key Index {key_idx} ({use_model}): {error_str}")
            
            is_rate_limited = any(msg in error_str for msg in ["429", "RATE_LIMIT", "RESOURCE_EXHAUSTED", "LIMIT_EXCEEDED", "QUOTA"])
            is_model_error = "NOT FOUND" in error_str or "MODEL" in error_str or "400" in error_str or "404" in error_str
            is_retryable = is_rate_limited or is_model_error or any(msg in error_str for msg in ["503", "500", "UNAVAILABLE", "SERVICE_UNAVAILABLE", "DEADLINE_EXCEEDED"])
            
            if is_retryable and attempt < max_retries - 1:
                if is_rate_limited:
                    print(f"  ⚡ Stream Rate limit detected on Key Index {key_idx}! Performing self-healing key rotation...")
                    rotate_groq_key()
                    continue
                
                wait = 0.5 if is_model_error else (attempt + 1) * 1.5
                time.sleep(wait)
            else:
                print(f"  ❌ Groq Stream Connection Error: {error_str}")
                raise e

    buffer = ""
    word_target = 0
    for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta and delta.content:
            buffer += delta.content
            spaces = buffer.count(" ")
            if spaces >= word_target:
                yield buffer
                buffer = ""
                word_target = 2
            elif "\n" in buffer:
                yield buffer
                buffer = ""
                word_target = 2
    if buffer:
        yield buffer
