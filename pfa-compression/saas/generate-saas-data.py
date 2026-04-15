#!/usr/bin/env python3

import csv
import json
import os
import random
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Dict
from uuid import uuid4


def env_int(name: str, default: int, minimum: int = 1) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"Environment variable {name} must be an integer, got: {raw}") from exc
    if value < minimum:
        raise ValueError(f"Environment variable {name} must be >= {minimum}, got: {value}")
    return value


def random_date(start: date, end: date) -> date:
    if end <= start:
        return start
    delta_days = (end - start).days
    return start + timedelta(days=random.randint(0, delta_days))


def random_timestamp(start: date, end: date) -> datetime:
    chosen = random_date(start, end)
    return datetime.combine(chosen, time(hour=random.randint(0, 23), minute=random.randint(0, 59), second=random.randint(0, 59)))


def month_start(d: date) -> date:
    return date(d.year, d.month, 1)


def add_month(d: date, months: int = 1) -> date:
    year = d.year + (d.month - 1 + months) // 12
    month = (d.month - 1 + months) % 12 + 1
    return date(year, month, 1)


@dataclass(frozen=True)
class PlanDef:
    plan_id: int
    plan_name: str
    tier: str
    monthly_price: float
    annual_price: float
    max_seats: int
    seat_factor: float
    features: list[str]


def choose_weighted(options: list[str], weights: list[float]) -> str:
    return random.choices(options, weights=weights, k=1)[0]


def main() -> None:
    scale = env_int("SAAS_SCALE_FACTOR", default=1, minimum=1)
    months = env_int("SAAS_MONTHS", default=24, minimum=3)
    seed = env_int("SAAS_SEED", default=42, minimum=1)
    data_dir = Path(os.getenv("DATA_DIR", "/tmp/saas_data")).resolve()

    random.seed(seed)
    data_dir.mkdir(parents=True, exist_ok=True)

    today = date.today()
    analysis_start = today - timedelta(days=months * 30)
    account_start_min = analysis_start - timedelta(days=365)

    plans = [
        PlanDef(1, "Starter", "starter", 99.0, 990.0, 25, 0.08, ["dashboards", "reports", "alerts"]),
        PlanDef(2, "Growth", "growth", 299.0, 2990.0, 80, 0.06, ["dashboards", "reports", "alerts", "automation", "integrations"]),
        PlanDef(3, "Pro", "pro", 799.0, 7990.0, 250, 0.05, ["dashboards", "reports", "alerts", "automation", "integrations", "cohorts", "forecasting"]),
        PlanDef(4, "Enterprise", "enterprise", 2499.0, 24990.0, 1000, 0.03, ["dashboards", "reports", "alerts", "automation", "integrations", "cohorts", "forecasting", "sso", "audit_logs"]),
    ]

    plan_weights = [0.46, 0.33, 0.16, 0.05]
    billing_cycle_weights = [0.74, 0.26]
    billing_cycles = ["monthly", "annual"]

    industries = ["SaaS", "Fintech", "HealthTech", "EdTech", "Retail", "Manufacturing", "Media", "Consulting"]
    industry_weights = [0.21, 0.14, 0.11, 0.10, 0.12, 0.09, 0.09, 0.14]

    segments = ["SMB", "Mid-Market", "Enterprise"]
    segment_weights = [0.58, 0.29, 0.13]

    regions = ["NA", "EMEA", "APAC", "LATAM"]
    region_weights = [0.43, 0.30, 0.20, 0.07]

    feature_names = [
        "dashboard",
        "search",
        "report_builder",
        "export",
        "alerts",
        "automation",
        "integrations",
        "cohorts",
        "forecasting",
        "anomaly_detection",
        "api",
        "billing",
    ]
    # Power-law style skew to mimic heavy concentration on a few core features.
    feature_weights = [35, 27, 20, 14, 11, 8, 6, 4, 3, 2.3, 1.8, 1.5]

    event_types_by_feature: Dict[str, list[str]] = {
        "dashboard": ["dashboard_viewed", "widget_refreshed"],
        "search": ["search_executed", "filter_applied"],
        "report_builder": ["report_created", "report_viewed", "report_scheduled"],
        "export": ["csv_exported", "pdf_exported"],
        "alerts": ["alert_created", "alert_trigger_viewed"],
        "automation": ["workflow_created", "workflow_executed"],
        "integrations": ["integration_connected", "sync_triggered"],
        "cohorts": ["cohort_created", "cohort_viewed"],
        "forecasting": ["forecast_generated", "forecast_compared"],
        "anomaly_detection": ["anomaly_viewed", "anomaly_acknowledged"],
        "api": ["api_call_succeeded", "api_call_failed"],
        "billing": ["invoice_viewed", "payment_method_updated"],
    }

    accounts_count = max(300, 1200 * scale)

    paths = {
        "plans": data_dir / "plans.csv",
        "accounts": data_dir / "accounts.csv",
        "users": data_dir / "users.csv",
        "subscriptions": data_dir / "subscriptions.csv",
        "invoices": data_dir / "invoices.csv",
        "events": data_dir / "events.csv",
        "feature_usage": data_dir / "feature_usage.csv",
    }

    account_user_ids: Dict[int, list[int]] = defaultdict(list)
    account_ranges: Dict[int, tuple[date, date, bool, int, float, str]] = {}

    with paths["plans"].open("w", newline="", encoding="utf-8") as plans_file:
        writer = csv.writer(plans_file)
        for plan in plans:
            writer.writerow([
                plan.plan_id,
                plan.plan_name,
                plan.tier,
                f"{plan.monthly_price:.2f}",
                f"{plan.annual_price:.2f}",
                plan.max_seats,
                json.dumps(plan.features),
            ])

    next_user_id = 1
    next_subscription_id = 1
    next_invoice_id = 1

    with (
        paths["accounts"].open("w", newline="", encoding="utf-8") as accounts_file,
        paths["users"].open("w", newline="", encoding="utf-8") as users_file,
        paths["subscriptions"].open("w", newline="", encoding="utf-8") as subscriptions_file,
        paths["invoices"].open("w", newline="", encoding="utf-8") as invoices_file,
    ):
        accounts_writer = csv.writer(accounts_file)
        users_writer = csv.writer(users_file)
        subscriptions_writer = csv.writer(subscriptions_file)
        invoices_writer = csv.writer(invoices_file)

        for account_id in range(1, accounts_count + 1):
            created_on = random_date(account_start_min, today - timedelta(days=30))
            industry = choose_weighted(industries, industry_weights)
            segment = choose_weighted(segments, segment_weights)
            region = choose_weighted(regions, region_weights)

            plan = random.choices(plans, weights=plan_weights, k=1)[0]
            billing_cycle = random.choices(billing_cycles, weights=billing_cycle_weights, k=1)[0]

            subscription_start = max(created_on, analysis_start - timedelta(days=90))
            churn_date: date | None = None
            probe_month = month_start(subscription_start)
            months_lived = 0
            while probe_month <= today:
                months_lived += 1
                if months_lived > 1 and random.random() < 0.05:
                    churn_date = probe_month + timedelta(days=random.randint(0, 27))
                    break
                probe_month = add_month(probe_month)

            is_account_active = churn_date is None or churn_date >= today
            status = "active" if is_account_active else "churned"
            sub_end = churn_date if churn_date is not None else today

            if plan.tier == "enterprise":
                seats = min(plan.max_seats, random.randint(120, 700))
            elif plan.tier == "pro":
                seats = min(plan.max_seats, random.randint(20, 180))
            elif plan.tier == "growth":
                seats = min(plan.max_seats, random.randint(8, 65))
            else:
                seats = min(plan.max_seats, random.randint(3, 20))

            mrr = round(plan.monthly_price * (1 + (seats - 1) * plan.seat_factor), 2)

            accounts_writer.writerow([
                account_id,
                f"account_{account_id:06d}",
                industry,
                segment,
                region,
                datetime.combine(created_on, time(hour=9, minute=0, second=0)).isoformat(sep=" "),
                "true" if is_account_active else "false",
            ])

            subscriptions_writer.writerow([
                next_subscription_id,
                account_id,
                plan.plan_id,
                billing_cycle,
                status,
                seats,
                f"{mrr:.2f}",
                subscription_start.isoformat(),
                "" if is_account_active else sub_end.isoformat(),
            ])

            account_ranges[account_id] = (subscription_start, sub_end, is_account_active, next_subscription_id, mrr, plan.tier)

            invoice_cursor = month_start(subscription_start)
            invoice_step = 12 if billing_cycle == "annual" else 1
            while invoice_cursor <= sub_end:
                amount = mrr * (12 if billing_cycle == "annual" else 1)
                if billing_cycle == "annual":
                    amount *= 0.9
                amount = round(amount * random.uniform(0.97, 1.03), 2)
                tax_amount = round(amount * random.uniform(0.08, 0.16), 2)
                total_amount = round(amount + tax_amount, 2)

                if random.random() < 0.92:
                    inv_status = "paid"
                    paid_date = invoice_cursor + timedelta(days=random.randint(1, 12))
                elif random.random() < 0.75:
                    inv_status = "overdue"
                    paid_date = None
                else:
                    inv_status = "failed"
                    paid_date = None

                due_date = invoice_cursor + timedelta(days=14)
                invoices_writer.writerow([
                    next_invoice_id,
                    account_id,
                    next_subscription_id,
                    invoice_cursor.isoformat(),
                    due_date.isoformat(),
                    "" if paid_date is None else paid_date.isoformat(),
                    inv_status,
                    f"{amount:.2f}",
                    f"{tax_amount:.2f}",
                    f"{total_amount:.2f}",
                ])
                next_invoice_id += 1
                invoice_cursor = add_month(invoice_cursor, invoice_step)

            # Power-law tails create a minority of very large accounts.
            tail = int(random.paretovariate(2.6)) - 1
            base_users = max(2, int(seats * random.uniform(0.55, 0.95)))
            user_count = min(220, base_users + max(0, tail))

            for _ in range(user_count):
                user_created = random_date(created_on, sub_end)
                user_is_active = is_account_active and random.random() < 0.86
                if user_is_active:
                    last_active = random_timestamp(max(user_created, today - timedelta(days=30)), today)
                else:
                    last_active = random_timestamp(user_created, sub_end)

                role = random.choices(
                    ["admin", "analyst", "member", "viewer"],
                    weights=[0.07, 0.23, 0.45, 0.25],
                    k=1,
                )[0]

                users_writer.writerow([
                    next_user_id,
                    account_id,
                    f"user_{next_user_id:07d}@account{account_id:06d}.example.com",
                    role,
                    datetime.combine(user_created, time(hour=9, minute=0, second=0)).isoformat(sep=" "),
                    last_active.isoformat(sep=" "),
                    "true" if user_is_active else "false",
                ])

                account_user_ids[account_id].append(next_user_id)
                next_user_id += 1

            next_subscription_id += 1

    next_event_id = 1
    next_usage_id = 1

    with (
        paths["events"].open("w", newline="", encoding="utf-8") as events_file,
        paths["feature_usage"].open("w", newline="", encoding="utf-8") as usage_file,
    ):
        events_writer = csv.writer(events_file)
        usage_writer = csv.writer(usage_file)

        for account_id in range(1, accounts_count + 1):
            sub_start, sub_end, is_account_active, _subscription_id, _mrr, plan_tier = account_ranges[account_id]
            user_ids = account_user_ids[account_id]
            if not user_ids:
                continue

            for user_id in user_ids:
                active_window_days = max(7, (sub_end - sub_start).days)
                engagement_base = random.lognormvariate(0.0, 0.75)

                # Heavier plans and active accounts naturally have more engagement.
                if plan_tier == "enterprise":
                    engagement_base *= 1.6
                elif plan_tier == "pro":
                    engagement_base *= 1.3
                elif plan_tier == "growth":
                    engagement_base *= 1.1

                if not is_account_active:
                    engagement_base *= 0.6

                active_day_count = int(min(active_window_days, max(3, engagement_base * active_window_days / 40)))
                seen_days = set()
                for _ in range(active_day_count):
                    seen_days.add(random_date(sub_start, sub_end))

                for usage_day in sorted(seen_days):
                    day_feature_counts: Dict[str, int] = defaultdict(int)
                    base_events = int(random.paretovariate(2.6) * 2)
                    day_events = min(80, max(1, int(base_events * max(0.35, engagement_base))))

                    sessions = max(1, day_events // random.randint(6, 14))
                    session_ids = [uuid4().hex[:24] for _ in range(sessions)]

                    for _ in range(day_events):
                        feature = choose_weighted(feature_names, feature_weights)
                        event_type = random.choice(event_types_by_feature[feature])
                        occurred_at = datetime.combine(
                            usage_day,
                            time(hour=random.randint(0, 23), minute=random.randint(0, 59), second=random.randint(0, 59)),
                        )

                        props = {
                            "source": random.choice(["web", "mobile", "api"]),
                            "plan_tier": plan_tier,
                            "ab_variant": random.choice(["A", "B"]),
                        }

                        events_writer.writerow([
                            next_event_id,
                            account_id,
                            user_id,
                            event_type,
                            feature,
                            occurred_at.isoformat(sep=" "),
                            random.choice(session_ids),
                            json.dumps(props, separators=(",", ":")),
                        ])
                        next_event_id += 1
                        day_feature_counts[feature] += 1

                    for feature, count in day_feature_counts.items():
                        usage_minutes = max(1, int(count * random.uniform(0.8, 2.9)))
                        usage_writer.writerow([
                            next_usage_id,
                            account_id,
                            user_id,
                            feature,
                            usage_day.isoformat(),
                            count,
                            usage_minutes,
                        ])
                        next_usage_id += 1

    print("=========================================")
    print("SaaS synthetic data generation complete")
    print("=========================================")
    print(f"accounts: {accounts_count}")
    print(f"users: {next_user_id - 1}")
    print(f"subscriptions: {next_subscription_id - 1}")
    print(f"invoices: {next_invoice_id - 1}")
    print(f"events: {next_event_id - 1}")
    print(f"feature_usage: {next_usage_id - 1}")
    print(f"data_dir: {data_dir}")


if __name__ == "__main__":
    main()
