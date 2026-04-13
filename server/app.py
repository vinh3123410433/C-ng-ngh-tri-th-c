import json
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request
from werkzeug.exceptions import BadRequest, HTTPException

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "data" / "requirements.db"
RULES_PATH = BASE_DIR / "data" / "rules.json"

ALLOWED_TYPES = {"FR", "NFR"}
ALLOWED_PRIORITY = {"low", "medium", "high"}
ALLOWED_SOURCE = {"user", "stakeholder", "system"}
ALLOWED_REL = {"depends_on", "conflicts_with", "duplicates"}
ALLOWED_TRACE = {"test_case", "design", "code"}

OPPOSITE_ACTIONS = {
    "allow": "deny",
    "deny": "allow",
    "enable": "disable",
    "disable": "enable",
    "increase": "decrease",
    "decrease": "increase",
    "accept": "reject",
    "reject": "accept",
    "login": "logout",
    "logout": "login",
    "encrypt": "decrypt",
    "decrypt": "encrypt",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def create_app() -> Flask:
    app = Flask(__name__)

    @app.errorhandler(BadRequest)
    def handle_bad_request(exc: BadRequest):
        return jsonify({"error": exc.description or "Bad request"}), 400

    @app.errorhandler(HTTPException)
    def handle_http_error(exc: HTTPException):
        if request.path.startswith("/api/"):
            return jsonify({"error": exc.description}), exc.code
        return exc

    @app.before_request
    def _before_request() -> None:
        get_db()

    @app.teardown_appcontext
    def _teardown(_exc):
        db = g.pop("db", None)
        if db:
            db.close()

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.post("/api/requirements")
    def create_requirement():
        payload = request.get_json(silent=True) or {}
        requirement = normalize_requirement_payload(payload)

        db = get_db()
        db.execute(
            """
            INSERT INTO requirements (
                id, title, description, type, priority, source, created_at,
                actor, action, object_name, constraint_text, conflict_flag
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                requirement["id"],
                requirement["title"],
                requirement["description"],
                requirement["type"],
                requirement["priority"],
                requirement["source"],
                requirement["created_at"],
                requirement["actor"],
                requirement["action"],
                requirement["object"],
                requirement["constraint"],
                0,
            ),
        )
        db.commit()
        scan_conflicts_and_duplicates()
        return jsonify(requirement), 201

    @app.get("/api/requirements")
    def list_requirements():
        req_type = request.args.get("type")
        priority = request.args.get("priority")

        query = "SELECT * FROM requirements WHERE 1=1"
        values = []
        if req_type in ALLOWED_TYPES:
            query += " AND type = ?"
            values.append(req_type)
        if priority in ALLOWED_PRIORITY:
            query += " AND priority = ?"
            values.append(priority)

        query += " ORDER BY datetime(created_at) DESC"
        rows = get_db().execute(query, values).fetchall()
        return jsonify([row_to_requirement(row) for row in rows])

    @app.put("/api/requirements/<req_id>")
    def update_requirement(req_id: str):
        db = get_db()
        existing = db.execute("SELECT * FROM requirements WHERE id = ?", (req_id,)).fetchone()
        if not existing:
            return jsonify({"error": "Requirement not found"}), 404

        payload = request.get_json(silent=True) or {}
        merged = {
            "id": req_id,
            "title": payload.get("title", existing["title"]),
            "description": payload.get("description", existing["description"]),
            "type": payload.get("type", existing["type"]),
            "priority": payload.get("priority", existing["priority"]),
            "source": payload.get("source", existing["source"]),
            "created_at": existing["created_at"],
            "actor": payload.get("actor", existing["actor"]),
            "action": payload.get("action", existing["action"]),
            "object": payload.get("object", existing["object_name"]),
            "constraint": payload.get("constraint", existing["constraint_text"]),
        }
        requirement = normalize_requirement_payload(merged, updating=True)

        db.execute(
            """
            UPDATE requirements
            SET title = ?, description = ?, type = ?, priority = ?, source = ?,
                actor = ?, action = ?, object_name = ?, constraint_text = ?
            WHERE id = ?
            """,
            (
                requirement["title"],
                requirement["description"],
                requirement["type"],
                requirement["priority"],
                requirement["source"],
                requirement["actor"],
                requirement["action"],
                requirement["object"],
                requirement["constraint"],
                req_id,
            ),
        )
        db.commit()
        scan_conflicts_and_duplicates()
        return jsonify(requirement)

    @app.delete("/api/requirements/<req_id>")
    def delete_requirement(req_id: str):
        db = get_db()
        db.execute("DELETE FROM trace_links WHERE requirement_id = ?", (req_id,))
        db.execute("DELETE FROM relationships WHERE from_req_id = ? OR to_req_id = ?", (req_id, req_id))
        deleted = db.execute("DELETE FROM requirements WHERE id = ?", (req_id,)).rowcount
        db.commit()
        if not deleted:
            return jsonify({"error": "Requirement not found"}), 404
        scan_conflicts_and_duplicates()
        return jsonify({"deleted": req_id})

    @app.post("/api/relationships")
    def add_relationship():
        payload = request.get_json(silent=True) or {}
        from_req_id = (payload.get("from_req_id") or "").strip()
        to_req_id = (payload.get("to_req_id") or "").strip()
        relation_type = (payload.get("relation_type") or "").strip()

        if relation_type not in ALLOWED_REL:
            return jsonify({"error": "Invalid relation_type"}), 400
        if not from_req_id or not to_req_id or from_req_id == to_req_id:
            return jsonify({"error": "from_req_id and to_req_id are required and must be different"}), 400

        db = get_db()
        exists = db.execute(
            "SELECT COUNT(*) FROM requirements WHERE id IN (?, ?)",
            (from_req_id, to_req_id),
        ).fetchone()[0]
        if exists != 2:
            return jsonify({"error": "Requirement ID not found"}), 404

        create_relationship_if_missing(from_req_id, to_req_id, relation_type)
        return jsonify({
            "from_req_id": from_req_id,
            "to_req_id": to_req_id,
            "relation_type": relation_type,
        }), 201

    @app.get("/api/requirements/<req_id>/related")
    def get_related_requirements(req_id: str):
        db = get_db()
        req = db.execute("SELECT id FROM requirements WHERE id = ?", (req_id,)).fetchone()
        if not req:
            return jsonify({"error": "Requirement not found"}), 404

        rows = db.execute(
            """
            SELECT r.relation_type, r.from_req_id, r.to_req_id,
                   req.id, req.title, req.description, req.type, req.priority,
                   req.source, req.created_at, req.actor, req.action,
                   req.object_name, req.constraint_text, req.conflict_flag
            FROM relationships r
            JOIN requirements req
                 ON req.id = CASE WHEN r.from_req_id = ? THEN r.to_req_id ELSE r.from_req_id END
            WHERE r.from_req_id = ? OR r.to_req_id = ?
            ORDER BY r.relation_type, req.id
            """,
            (req_id, req_id, req_id),
        ).fetchall()

        related = []
        for row in rows:
            rel = {
                "relation_type": row["relation_type"],
                "from_req_id": row["from_req_id"],
                "to_req_id": row["to_req_id"],
                "requirement": {
                    "id": row["id"],
                    "title": row["title"],
                    "description": row["description"],
                    "type": row["type"],
                    "priority": row["priority"],
                    "source": row["source"],
                    "created_at": row["created_at"],
                    "actor": row["actor"],
                    "action": row["action"],
                    "object": row["object_name"],
                    "constraint": row["constraint_text"],
                    "conflict_flag": bool(row["conflict_flag"]),
                },
            }
            related.append(rel)

        return jsonify(related)

    @app.post("/api/traceability")
    def add_traceability():
        payload = request.get_json(silent=True) or {}
        requirement_id = (payload.get("requirement_id") or "").strip()
        trace_type = (payload.get("trace_type") or "").strip()
        target_ref = (payload.get("target_ref") or "").strip()
        note = (payload.get("note") or "").strip()

        if trace_type not in ALLOWED_TRACE:
            return jsonify({"error": "Invalid trace_type"}), 400
        if not requirement_id or not target_ref:
            return jsonify({"error": "requirement_id and target_ref are required"}), 400

        db = get_db()
        exists = db.execute("SELECT id FROM requirements WHERE id = ?", (requirement_id,)).fetchone()
        if not exists:
            return jsonify({"error": "Requirement not found"}), 404

        db.execute(
            """
            INSERT INTO trace_links (requirement_id, trace_type, target_ref, note, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (requirement_id, trace_type, target_ref, note, now_iso()),
        )
        db.commit()

        return jsonify({
            "requirement_id": requirement_id,
            "trace_type": trace_type,
            "target_ref": target_ref,
            "note": note,
        }), 201

    @app.get("/api/traceability/<req_id>")
    def get_traceability(req_id: str):
        db = get_db()
        req = db.execute("SELECT * FROM requirements WHERE id = ?", (req_id,)).fetchone()
        if not req:
            return jsonify({"error": "Requirement not found"}), 404

        links = db.execute(
            """
            SELECT id, requirement_id, trace_type, target_ref, note, created_at
            FROM trace_links
            WHERE requirement_id = ?
            ORDER BY datetime(created_at) DESC
            """,
            (req_id,),
        ).fetchall()

        rels = db.execute(
            "SELECT from_req_id, to_req_id, relation_type FROM relationships WHERE from_req_id = ? OR to_req_id = ?",
            (req_id, req_id),
        ).fetchall()

        tree = {
            "requirement": row_to_requirement(req),
            "trace_links": [dict(row) for row in links],
            "relations": [dict(row) for row in rels],
        }
        return jsonify(tree)

    @app.get("/api/conflicts")
    def get_conflicts():
        report = scan_conflicts_and_duplicates()
        db = get_db()
        conflicts = db.execute(
            "SELECT * FROM relationships WHERE relation_type = 'conflicts_with' ORDER BY from_req_id, to_req_id"
        ).fetchall()
        return jsonify({
            "report": report,
            "conflicts": [dict(row) for row in conflicts],
        })

    @app.get("/api/dashboard")
    def get_dashboard():
        db = get_db()
        total = db.execute("SELECT COUNT(*) FROM requirements").fetchone()[0]
        fr_count = db.execute("SELECT COUNT(*) FROM requirements WHERE type = 'FR'").fetchone()[0]
        nfr_count = db.execute("SELECT COUNT(*) FROM requirements WHERE type = 'NFR'").fetchone()[0]
        conflict_count = db.execute(
            "SELECT COUNT(*) FROM relationships WHERE relation_type = 'conflicts_with'"
        ).fetchone()[0]
        duplicate_count = db.execute(
            "SELECT COUNT(*) FROM relationships WHERE relation_type = 'duplicates'"
        ).fetchone()[0]

        by_priority = db.execute(
            "SELECT priority, COUNT(*) AS count FROM requirements GROUP BY priority"
        ).fetchall()

        return jsonify(
            {
                "total_requirements": total,
                "fr": fr_count,
                "nfr": nfr_count,
                "conflicts": conflict_count,
                "duplicates": duplicate_count,
                "priority": {row["priority"]: row["count"] for row in by_priority},
            }
        )

    @app.get("/api/graph")
    def get_graph_data():
        db = get_db()
        nodes = db.execute(
            "SELECT id, title, type, priority, conflict_flag FROM requirements ORDER BY id"
        ).fetchall()
        edges = db.execute(
            "SELECT from_req_id AS source, to_req_id AS target, relation_type FROM relationships"
        ).fetchall()
        return jsonify(
            {
                "nodes": [dict(row) for row in nodes],
                "edges": [dict(row) for row in edges],
            }
        )

    return app


def get_db() -> sqlite3.Connection:
    db = g.get("db")
    if db is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(DB_PATH)
        db.row_factory = sqlite3.Row
        g.db = db
        init_db(db)
    return db


def init_db(db: sqlite3.Connection) -> None:
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS requirements (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('FR', 'NFR')),
            priority TEXT NOT NULL CHECK(priority IN ('low', 'medium', 'high')),
            source TEXT NOT NULL CHECK(source IN ('user', 'stakeholder', 'system')),
            created_at TEXT NOT NULL,
            actor TEXT,
            action TEXT,
            object_name TEXT,
            constraint_text TEXT,
            conflict_flag INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS relationships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_req_id TEXT NOT NULL,
            to_req_id TEXT NOT NULL,
            relation_type TEXT NOT NULL CHECK(relation_type IN ('depends_on', 'conflicts_with', 'duplicates')),
            created_at TEXT NOT NULL,
            UNIQUE(from_req_id, to_req_id, relation_type),
            FOREIGN KEY(from_req_id) REFERENCES requirements(id) ON DELETE CASCADE,
            FOREIGN KEY(to_req_id) REFERENCES requirements(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS trace_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            requirement_id TEXT NOT NULL,
            trace_type TEXT NOT NULL CHECK(trace_type IN ('test_case', 'design', 'code')),
            target_ref TEXT NOT NULL,
            note TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(requirement_id) REFERENCES requirements(id) ON DELETE CASCADE
        );
        """
    )
    db.commit()


def row_to_requirement(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "type": row["type"],
        "priority": row["priority"],
        "source": row["source"],
        "created_at": row["created_at"],
        "actor": row["actor"] or "",
        "action": row["action"] or "",
        "object": row["object_name"] or "",
        "constraint": row["constraint_text"] or "",
        "conflict_flag": bool(row["conflict_flag"]),
    }


def normalize_requirement_payload(payload: dict, updating: bool = False) -> dict:
    req_type = (payload.get("type") or "FR").strip().upper()
    priority = (payload.get("priority") or "medium").strip().lower()
    source = (payload.get("source") or "user").strip().lower()

    if req_type not in ALLOWED_TYPES:
        raise_bad_request("type must be FR or NFR")
    if priority not in ALLOWED_PRIORITY:
        raise_bad_request("priority must be low, medium, or high")
    if source not in ALLOWED_SOURCE:
        raise_bad_request("source must be user, stakeholder, or system")

    title = (payload.get("title") or "").strip()
    description = (payload.get("description") or "").strip()
    if not title or not description:
        raise_bad_request("title and description are required")

    actor = (payload.get("actor") or "").strip()
    action = (payload.get("action") or "").strip()
    object_name = (payload.get("object") or "").strip()
    constraint = (payload.get("constraint") or "").strip()

    if not (actor and action and object_name):
        parsed = parse_actor_action_object_constraint(description)
        actor = actor or parsed["actor"]
        action = action or parsed["action"]
        object_name = object_name or parsed["object"]
        constraint = constraint or parsed["constraint"]

    if not updating:
        req_id = (payload.get("id") or "").strip() or f"REQ-{uuid.uuid4().hex[:8].upper()}"
        created_at = payload.get("created_at") or now_iso()
    else:
        req_id = payload["id"]
        created_at = payload["created_at"]

    return {
        "id": req_id,
        "title": title,
        "description": description,
        "type": req_type,
        "priority": priority,
        "source": source,
        "created_at": created_at,
        "actor": actor,
        "action": action,
        "object": object_name,
        "constraint": constraint,
    }


def parse_actor_action_object_constraint(description: str) -> dict:
    text = re.sub(r"\s+", " ", description.strip())
    split = re.split(r"\s*[\-\u2013]\s*", text)
    if len(split) >= 4:
        return {
            "actor": split[0].strip(),
            "action": split[1].strip(),
            "object": split[2].strip(),
            "constraint": split[3].strip(),
        }

    actor_match = re.match(r"^([A-Za-z][A-Za-z0-9_ ]{1,30})\s+(shall|must|can|will)\s+", text, flags=re.IGNORECASE)
    actor = actor_match.group(1).strip() if actor_match else ""

    action = ""
    action_match = re.search(r"\b(allow|deny|enable|disable|increase|decrease|accept|reject|login|logout|encrypt|decrypt|display|create|update|delete)\b", text, flags=re.IGNORECASE)
    if action_match:
        action = action_match.group(1).lower()

    object_name = ""
    if action:
        object_match = re.search(rf"{action}\s+([A-Za-z0-9_ ]+?)(?:\s+(within|under|in|before|after)\b|$)", text, flags=re.IGNORECASE)
        if object_match:
            object_name = object_match.group(1).strip()

    constraint = ""
    constraint_match = re.search(r"(within|under|in|before|after|less than|more than).*$", text, flags=re.IGNORECASE)
    if constraint_match:
        constraint = constraint_match.group(0).strip()

    return {
        "actor": actor,
        "action": action,
        "object": object_name,
        "constraint": constraint,
    }


def parse_constraint_range(text: str) -> tuple[float | None, float | None]:
    if not text:
        return None, None

    lower = None
    upper = None
    normalized = text.lower().replace(" ", "")

    lt = re.search(r"<(?P<num>\d+(?:\.\d+)?)s", normalized)
    lte = re.search(r"<=(?P<num>\d+(?:\.\d+)?)s", normalized)
    gt = re.search(r">(?P<num>\d+(?:\.\d+)?)s", normalized)
    gte = re.search(r">=(?P<num>\d+(?:\.\d+)?)s", normalized)

    if lt:
        upper = float(lt.group("num")) - 1e-9
    if lte:
        upper = float(lte.group("num"))
    if gt:
        lower = float(gt.group("num")) + 1e-9
    if gte:
        lower = float(gte.group("num"))

    return lower, upper


def is_opposite_action(action_a: str, action_b: str) -> bool:
    if not action_a or not action_b:
        return False
    a = action_a.strip().lower()
    b = action_b.strip().lower()
    return OPPOSITE_ACTIONS.get(a) == b or OPPOSITE_ACTIONS.get(b) == a


def has_conflicting_constraints(constraint_a: str, constraint_b: str) -> bool:
    low_a, up_a = parse_constraint_range(constraint_a)
    low_b, up_b = parse_constraint_range(constraint_b)

    if low_a is None and up_a is None:
        return False
    if low_b is None and up_b is None:
        return False

    merged_low = max(x for x in [low_a, low_b] if x is not None) if (low_a is not None or low_b is not None) else None
    merged_up = min(x for x in [up_a, up_b] if x is not None) if (up_a is not None or up_b is not None) else None

    return merged_low is not None and merged_up is not None and merged_low > merged_up


def are_duplicates(req_a: sqlite3.Row, req_b: sqlite3.Row) -> bool:
    return (
        (req_a["actor"] or "").strip().lower() == (req_b["actor"] or "").strip().lower()
        and (req_a["action"] or "").strip().lower() == (req_b["action"] or "").strip().lower()
        and (req_a["object_name"] or "").strip().lower() == (req_b["object_name"] or "").strip().lower()
        and (req_a["constraint_text"] or "").strip().lower() == (req_b["constraint_text"] or "").strip().lower()
    )


def canonical_pair(req_a: str, req_b: str) -> tuple[str, str]:
    return (req_a, req_b) if req_a < req_b else (req_b, req_a)


def create_relationship_if_missing(from_req_id: str, to_req_id: str, relation_type: str) -> None:
    db = get_db()
    pair = canonical_pair(from_req_id, to_req_id) if relation_type in {"conflicts_with", "duplicates"} else (from_req_id, to_req_id)
    db.execute(
        """
        INSERT OR IGNORE INTO relationships (from_req_id, to_req_id, relation_type, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (pair[0], pair[1], relation_type, now_iso()),
    )
    db.commit()


def remove_derived_relationships() -> None:
    db = get_db()
    db.execute("DELETE FROM relationships WHERE relation_type IN ('conflicts_with', 'duplicates')")
    db.execute("UPDATE requirements SET conflict_flag = 0")
    db.commit()


def scan_conflicts_and_duplicates() -> dict:
    with open(RULES_PATH, "r", encoding="utf-8") as file:
        rules = json.load(file)

    db = get_db()
    reqs = db.execute("SELECT * FROM requirements ORDER BY id").fetchall()

    remove_derived_relationships()
    conflict_pairs = 0
    duplicate_pairs = 0
    conflicted_ids = set()
    conflict_pair_keys = set()

    for i, req_a in enumerate(reqs):
        for req_b in reqs[i + 1 :]:
            same_actor_object = (
                (req_a["actor"] or "").strip().lower() == (req_b["actor"] or "").strip().lower()
                and (req_a["object_name"] or "").strip().lower() == (req_b["object_name"] or "").strip().lower()
                and (req_a["actor"] or "").strip() != ""
                and (req_a["object_name"] or "").strip() != ""
            )

            if same_actor_object and is_opposite_action(req_a["action"] or "", req_b["action"] or ""):
                create_relationship_if_missing(req_a["id"], req_b["id"], "conflicts_with")
                key = canonical_pair(req_a["id"], req_b["id"])
                conflict_pair_keys.add(key)
                conflicted_ids.update([req_a["id"], req_b["id"]])

            if same_actor_object and has_conflicting_constraints(req_a["constraint_text"] or "", req_b["constraint_text"] or ""):
                create_relationship_if_missing(req_a["id"], req_b["id"], "conflicts_with")
                key = canonical_pair(req_a["id"], req_b["id"])
                conflict_pair_keys.add(key)
                conflicted_ids.update([req_a["id"], req_b["id"]])

            if are_duplicates(req_a, req_b):
                create_relationship_if_missing(req_a["id"], req_b["id"], "duplicates")
                duplicate_pairs += 1

    if conflicted_ids:
        db.executemany(
            "UPDATE requirements SET conflict_flag = 1 WHERE id = ?",
            [(req_id,) for req_id in conflicted_ids],
        )
    db.commit()

    conflict_pairs = len(conflict_pair_keys)

    return {
        "rules_loaded": len(rules),
        "conflict_pairs_detected": conflict_pairs,
        "duplicate_pairs_detected": duplicate_pairs,
        "requirements_flagged": len(conflicted_ids),
    }


def raise_bad_request(message: str):
    raise BadRequest(description=message)


app = create_app()


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
