import json

def _get_doc_display(doc_type: str) -> str:
    doc_name_map = {
        "fx_ndf":     "FX Non-Deliverable Forward (NDF)",
        "irs":        "Interest Rate Swap (IRS) Confirmation",
        "cds":        "Credit Default Swap (CDS) Confirmation",
        "equity_trs": "Equity Total Return Swap (TRS) Confirmation",
    }
    return doc_name_map.get(doc_type, doc_type.upper() if doc_type else "Document")

def _summarise_schema(s: dict) -> str:
    if not isinstance(s, dict): return ""
    lines = []
    sections = s.get("sections", {})
    if isinstance(sections, dict):
        for sec_key, sec in sections.items():
            lines.append(f"\nSection: {sec.get('title', sec_key)}")
            for f in sec.get("fields", []):
                req = "[required]" if f.get("required") else ""
                lines.append(f"  - {f.get('label','')} (key: {f.get('key','')}): {f.get('type','')} {req}")
            for sub in sec.get("subsections", []):
                lines.append(f"  Subsection: {sub.get('title','')}")
                for f in sub.get("fields", []):
                    req = "[required]" if f.get("required") else ""
                    lines.append(f"    - {f.get('label','')} (key: {f.get('key','')}): {f.get('type','')} {req}")
    elif isinstance(sections, list):
        for sec in sections:
            lines.append(f"\nSection: {sec.get('title', sec.get('id', ''))}")
            for f in sec.get("fields", []):
                req = "[required]" if f.get("required") else ""
                lines.append(f"  - {f.get('label','')} (key: {f.get('key','')}): {f.get('type','')} {req}")
            for sub in sec.get("subsections", []):
                lines.append(f"  Subsection: {sub.get('title','')}")
                for f in sub.get("fields", []):
                    req = "[required]" if f.get("required") else ""
                    lines.append(f"    - {f.get('label','')} (key: {f.get('key','')}): {f.get('type','')} {req}")
    return "\n".join(lines) if lines else json.dumps(s, indent=2)[:3000]

def build_global_prompt(user_msg: str) -> str:
    """Prompt for the Global Agent (Main Dashboard)."""
    return f"""You are the TradeDoc AI Global Assistant.
You live on the main dashboard of the TradeDoc AI platform.

USER MESSAGE:
{user_msg}

INSTRUCTIONS:
1. Answer general questions about the TradeDoc AI product, supported documents (IRS, CDS, FX NDF, Equity TRS), and platform capabilities.
2. You HAVE NAVIGATION POWERS. If the user asks to go somewhere (e.g., "Take me to settings", "Go to new document", "Show my documents"), you must reply comprehensively and also include an action tag for the UI. (Valid routes are /dashboard, /dashboard/documents, /dashboard/settings, /dashboard/dispatch).
3. Do not ask for document details, as you do not have access to any specific document context here.
4. Keep the tone friendly, expert, and professional.
"""

def build_local_prompt(user_msg: str, doc_type: str, schema: dict, current_data: dict) -> str:
    """Prompt for the Local Agent (PDF View / AI Mode Forms)."""
    doc_display = _get_doc_display(doc_type)
    schema_summary = _summarise_schema(schema)
    filled_str = json.dumps(current_data, indent=2) if current_data else "No fields extracted/filled."

    return f"""You are the TradeDoc AI Local Assistant.
You are currently helping the user view a specific {doc_display} document.

DOCUMENT EXTRACTED DATA:
{filled_str}

DOCUMENT SCHEMA (For context):
{schema_summary}

USER MESSAGE:
{user_msg}

INSTRUCTIONS:
1. You DO NOT HAVE navigation powers. If the user asks to navigate, politely decline and inform them they can use the sidebar.
2. Answer questions strictly based on the DOCUMENT EXTRACTED DATA provided above. 
3. If the user asks "Who are the parties?", "What is the date?", etc., provide the actual values from the data, NOT the schema definition.
4. Help the user verify if the AI extracted the document correctly.
5. If the user asks something not present in the data, state clearly that it is not in the current document data.
6. Use clean markdown formatting (like bolding or bullet points) to present your answers clearly.
"""

def build_assistive_prompt(user_msg: str, doc_type: str, schema: dict, current_data: dict, active_field: str) -> str:
    """Prompt for the Assistive Local Agent (Manual Mode Forms)."""
    doc_display = _get_doc_display(doc_type)
    schema_summary = _summarise_schema(schema)
    filled = {k: v for k, v in (current_data or {}).items() if v not in (None, "", [], {})}
    filled_str = json.dumps(filled, indent=2) if filled else "No fields filled yet."
    active_field_str = f"The user's cursor is currently focused on the field with key: '{active_field}'." if active_field else "The user is not currently focused on any specific field."

    return f"""You are the TradeDoc AI Assistive Form Assistant.
You are currently helping the user manually fill out a {doc_display} form.

USER CONTEXT:
{active_field_str}

FILLED FORM DATA SO FAR:
{filled_str}

FORM SCHEMA DEFINITIONS:
{schema_summary}

USER MESSAGE:
{user_msg}

INSTRUCTIONS:
You are a highly aware form-filling copilot. You have special functionalities unlocked based on the user's intent:

1. CHECK FOR ERRORS: If the user asks to review or check for mistakes, look ONLY at the FILLED FORM DATA. Check for typos, unusual amounts, placeholder text, or nonsensical strings. Explain issues politely. Do not mention empty fields.
2. CHECK MISSING FIELDS: If the user asks what is missing or left to fill, compare the FILLED FORM DATA against the required fields in the FORM SCHEMA DEFINITIONS. List only the required fields that are still empty, grouped by section.
3. EXPLAIN FIELDS: If the user asks about a specific field (or asks generally while focused on the {active_field}), explain its legal and financial significance in the context of a {doc_display}. Give a realistic example of what should be typed there.
4. GENERAL HELP: For any other questions, provide expert financial guidance on creating this document. 
5. NO NAVIGATION: You cannot navigate the platform. Stick to form assistance.

Keep your responses highly informative, professional, and well-formatted using markdown.
"""
