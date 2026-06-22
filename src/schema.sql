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

CREATE INDEX IF NOT EXISTS idx_tickets_status   ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_from     ON tickets(from_email);
