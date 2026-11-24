"""Persist sanitized ordinary scan failure details.

Revision ID: 009_cds_scan_failure_details
Revises: 008_add_files_with_findings
"""
from alembic import op
import sqlalchemy as sa

revision = '009_cds_scan_failure_details'
down_revision = '008_add_files_with_findings'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('audit_tasks', sa.Column('error_code', sa.String(length=64), nullable=True))
    op.add_column('audit_tasks', sa.Column('error_message', sa.Text(), nullable=True))


def downgrade():
    op.drop_column('audit_tasks', 'error_message')
    op.drop_column('audit_tasks', 'error_code')
