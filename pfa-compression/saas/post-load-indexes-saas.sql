-- SaaS post-load indexes
-- Run after bulk COPY to avoid index maintenance overhead during large imports.

CREATE INDEX IF NOT EXISTS idx_accounts_created_at ON accounts(created_at);
CREATE INDEX IF NOT EXISTS idx_users_account_id ON users(account_id);
CREATE INDEX IF NOT EXISTS idx_users_last_active_at ON users(last_active_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_account_status ON subscriptions(account_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_plan_id ON subscriptions(plan_id);
CREATE INDEX IF NOT EXISTS idx_invoices_account_date ON invoices(account_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_events_account_time ON events(account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_feature_time ON events(feature_name, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON events(user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_feature_usage_account_day ON feature_usage(account_id, usage_date);
CREATE INDEX IF NOT EXISTS idx_feature_usage_feature_day ON feature_usage(feature_name, usage_date);
