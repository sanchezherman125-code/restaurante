"""direct delivery items do not require preparation

Revision ID: 0003_direct_delivery_items
Revises: 0002_critical_high_integrity
Create Date: 2026-10-03
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003_direct_delivery_items"
down_revision: Union[str, None] = "0002_critical_high_integrity"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "menu_items", sa.Column("requires_preparation", sa.Boolean(), nullable=False, server_default=sa.true())
    )
    op.add_column(
        "order_items", sa.Column("requires_preparation", sa.Boolean(), nullable=False, server_default=sa.true())
    )
    op.alter_column("menu_items", "preparation_area", existing_type=sa.String(length=16), nullable=True)
    op.alter_column("order_items", "preparation_area", existing_type=sa.String(length=16), nullable=True)
    op.execute(
        "UPDATE menu_items SET requires_preparation = false, preparation_area = NULL, "
        "expected_prep_minutes = NULL WHERE preparation_area = 'WAITER'"
    )
    op.execute(
        "UPDATE order_items SET requires_preparation = false, preparation_area = NULL, "
        "expected_prep_minutes_snapshot = NULL WHERE preparation_area = 'WAITER'"
    )
    op.alter_column("menu_items", "requires_preparation", server_default=None)
    op.alter_column("order_items", "requires_preparation", server_default=None)


def downgrade() -> None:
    op.execute("UPDATE menu_items SET preparation_area = 'WAITER' WHERE preparation_area IS NULL")
    op.execute("UPDATE order_items SET preparation_area = 'WAITER' WHERE preparation_area IS NULL")
    op.alter_column(
        "menu_items", "preparation_area", existing_type=sa.String(length=16), nullable=False, server_default="KITCHEN"
    )
    op.alter_column(
        "order_items", "preparation_area", existing_type=sa.String(length=16), nullable=False, server_default="KITCHEN"
    )
    op.drop_column("order_items", "requires_preparation")
    op.drop_column("menu_items", "requires_preparation")
