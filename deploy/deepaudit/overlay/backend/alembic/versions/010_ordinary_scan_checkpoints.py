"""Persist ordinary scan file checkpoints and coverage counters.
Revision ID: 010_ordinary_scan_checkpoints
Revises: 009_cds_scan_failure_details
"""
from alembic import op
import sqlalchemy as sa
revision = '010_ordinary_scan_checkpoints'
down_revision = '009_cds_scan_failure_details'
branch_labels = None
depends_on = None


def upgrade():
    for name in ['checkpoint_version', 'processed_files', 'failed_files', 'skipped_files']:
        op.add_column('audit_tasks', sa.Column(name, sa.Integer(), nullable=False, server_default='0'))
    op.add_column('audit_tasks', sa.Column('snapshot_sha256', sa.String(64), nullable=True))
    op.create_table('audit_file_results',
        sa.Column('id', sa.String(), primary_key=True),
        sa.Column('task_id', sa.String(), sa.ForeignKey('audit_tasks.id', ondelete='CASCADE'), nullable=False),
        sa.Column('file_path', sa.Text(), nullable=False),
        sa.Column('member_name', sa.Text(), nullable=False),
        sa.Column('source_hash', sa.String(64), nullable=True),
        sa.Column('status', sa.String(20), nullable=False),
        sa.Column('skip_reason', sa.String(64), nullable=True),
        sa.Column('line_count', sa.Integer(), nullable=False),
        sa.Column('quality_score', sa.Float(), nullable=True),
        sa.Column('error_code', sa.String(64), nullable=True),
        sa.UniqueConstraint('task_id', 'file_path', name='uq_audit_file_task_path'))
    op.create_index('ix_audit_file_results_task_id', 'audit_file_results', ['task_id'])


def downgrade():
    op.drop_index('ix_audit_file_results_task_id', table_name='audit_file_results')
    op.drop_table('audit_file_results')
    for name in ['snapshot_sha256', 'skipped_files', 'failed_files', 'processed_files', 'checkpoint_version']:
        op.drop_column('audit_tasks', name)
