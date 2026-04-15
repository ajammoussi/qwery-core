-- SaaS / B2B Analytics Synthetic Schema

CREATE TABLE plans (
    plan_id          INTEGER PRIMARY KEY,
    plan_name        VARCHAR(50) NOT NULL UNIQUE,
    tier             VARCHAR(30) NOT NULL,
    monthly_price    DECIMAL(12,2) NOT NULL,
    annual_price     DECIMAL(12,2) NOT NULL,
    max_seats        INTEGER NOT NULL,
    feature_flags    JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE accounts (
    account_id       INTEGER PRIMARY KEY,
    account_name     VARCHAR(120) NOT NULL,
    industry         VARCHAR(60) NOT NULL,
    segment          VARCHAR(30) NOT NULL,
    region           VARCHAR(30) NOT NULL,
    created_at       TIMESTAMP NOT NULL,
    is_active        BOOLEAN NOT NULL
);

CREATE TABLE users (
    user_id          INTEGER PRIMARY KEY,
    account_id       INTEGER NOT NULL REFERENCES accounts(account_id),
    email            VARCHAR(180) NOT NULL UNIQUE,
    role             VARCHAR(30) NOT NULL,
    created_at       TIMESTAMP NOT NULL,
    last_active_at   TIMESTAMP,
    is_active        BOOLEAN NOT NULL
);

CREATE TABLE subscriptions (
    subscription_id  INTEGER PRIMARY KEY,
    account_id       INTEGER NOT NULL REFERENCES accounts(account_id),
    plan_id          INTEGER NOT NULL REFERENCES plans(plan_id),
    billing_cycle    VARCHAR(20) NOT NULL,
    status           VARCHAR(30) NOT NULL,
    seats            INTEGER NOT NULL,
    mrr              DECIMAL(12,2) NOT NULL,
    start_date       DATE NOT NULL,
    end_date         DATE
);

CREATE TABLE invoices (
    invoice_id       BIGINT PRIMARY KEY,
    account_id       INTEGER NOT NULL REFERENCES accounts(account_id),
    subscription_id  INTEGER NOT NULL REFERENCES subscriptions(subscription_id),
    invoice_date     DATE NOT NULL,
    due_date         DATE NOT NULL,
    paid_date        DATE,
    status           VARCHAR(30) NOT NULL,
    amount           DECIMAL(12,2) NOT NULL,
    tax_amount       DECIMAL(12,2) NOT NULL,
    total_amount     DECIMAL(12,2) NOT NULL
);

CREATE TABLE events (
    event_id         BIGINT PRIMARY KEY,
    account_id       INTEGER NOT NULL REFERENCES accounts(account_id),
    user_id          INTEGER NOT NULL REFERENCES users(user_id),
    event_type       VARCHAR(80) NOT NULL,
    feature_name     VARCHAR(80) NOT NULL,
    occurred_at      TIMESTAMP NOT NULL,
    session_id       VARCHAR(64) NOT NULL,
    properties       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE feature_usage (
    usage_id         BIGINT PRIMARY KEY,
    account_id       INTEGER NOT NULL REFERENCES accounts(account_id),
    user_id          INTEGER NOT NULL REFERENCES users(user_id),
    feature_name     VARCHAR(80) NOT NULL,
    usage_date       DATE NOT NULL,
    event_count      INTEGER NOT NULL,
    active_minutes   INTEGER NOT NULL
);

