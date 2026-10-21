"""Associate browser push subscriptions with a login device."""

import sqlalchemy as sa
from alembic import op

revision = "0006_push_device"
down_revision = "0005_production_security"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("push_subscriptions", sa.Column("device_id", sa.String(length=64), nullable=True))
    op.create_index("ix_push_subscriptions_user_device", "push_subscriptions", ["user_id", "device_id"])


def downgrade() -> None:
    op.drop_index("ix_push_subscriptions_user_device", table_name="push_subscriptions")
    op.drop_column("push_subscriptions", "device_id")
