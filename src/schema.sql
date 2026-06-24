-- RapidMoney CRM schema (PostgreSQL 16)

CREATE TABLE IF NOT EXISTS tickets (
    id              SERIAL PRIMARY KEY,
    message_id      VARCHAR(500) UNIQUE,
    thread_id       VARCHAR(500),
    from_email      VARCHAR(255),
    from_name       VARCHAR(255),
    subject         TEXT,
    body            TEXT,
    received_at     TIMESTAMPTZ,
    category        CHAR(1),                       -- Q / R / C / NULL
    sub_category    VARCHAR(100),
    priority        VARCHAR(2) DEFAULT 'P3',       -- P1 / P2 / P3
    sentiment_score DOUBLE PRECISION,              -- reserved for Phase 2 AI
    status          VARCHAR(30) DEFAULT 'Open',
    assigned_to     VARCHAR(100),                  -- reserved for Phase 4
    sla_due_at      TIMESTAMPTZ,
    sla_breached    BOOLEAN DEFAULT FALSE,
    escalated_at    TIMESTAMPTZ,
    is_read         BOOLEAN DEFAULT FALSE,         -- agent has opened it
    flagged         BOOLEAN DEFAULT FALSE,         -- flagged for follow-up
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_notes (
    id          SERIAL PRIMARY KEY,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    note        TEXT,
    is_internal BOOLEAN DEFAULT TRUE,
    created_by  VARCHAR(100),
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_replies (
    id          SERIAL PRIMARY KEY,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    direction   VARCHAR(10),                       -- inbound / outbound
    from_email  VARCHAR(255),
    to_email    VARCHAR(255),
    subject     TEXT,
    body        TEXT,
    sent_by     VARCHAR(100),
    sent_at     TIMESTAMPTZ DEFAULT now()
);

-- runtime, UI-editable settings (key/value)
CREATE TABLE IF NOT EXISTS app_settings (
    key        VARCHAR(60) PRIMARY KEY,
    value      TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tickets_status   ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_from     ON tickets(from_email);

-- ───────────────────────── Auth / RBAC ─────────────────────────

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         VARCHAR(255) UNIQUE NOT NULL,
    name          VARCHAR(255),
    password      VARCHAR(255),                    -- bcrypt hash; NULL until set
    password_set  BOOLEAN DEFAULT FALSE,
    status        VARCHAR(20) DEFAULT 'Active',    -- Active / Inactive
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(80) UNIQUE NOT NULL,
    description   TEXT,
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
    id            SERIAL PRIMARY KEY,
    slug          VARCHAR(80) UNIQUE NOT NULL,     -- e.g. users.create
    name          VARCHAR(120),
    description   TEXT,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- user ⟷ role (many-to-many)
CREATE TABLE IF NOT EXISTS user_roles (
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- role ⟷ permission (many-to-many)
CREATE TABLE IF NOT EXISTS role_permissions (
    role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

-- per-user allocation of app modules/components (mail, analytics, ...)
CREATE TABLE IF NOT EXISTS user_modules (
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module_key    VARCHAR(40) NOT NULL,
    PRIMARY KEY (user_id, module_key)
);

-- active session tokens — single session per user is enforced in code
CREATE TABLE IF NOT EXISTS tokens (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token         TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_logs (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    method        VARCHAR(10),
    path          TEXT,
    status_code   INTEGER,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_modules_user  ON user_modules(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_token       ON tokens(token);
CREATE INDEX IF NOT EXISTS idx_tokens_user        ON tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user    ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_role_perms_role    ON role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_activity_user      ON activity_logs(user_id);
