-- Migration: 020_connector_actions.up.sql
-- Introduces the connector_actions catalog: named business actions (resource +
-- verb + field schema) that let builders configure REST/GraphQL mutation steps
-- through a guided UI instead of raw JSON.

CREATE TABLE IF NOT EXISTS connector_actions (
    id              TEXT        NOT NULL DEFAULT ('ca-' || gen_random_uuid()::text),
    connector_id    UUID        NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    resource_name   TEXT        NOT NULL,                -- e.g. "Contacts"
    action_key      TEXT        NOT NULL,                -- e.g. "create_contact"
    action_label    TEXT        NOT NULL,                -- e.g. "Create contact"
    description     TEXT        NOT NULL DEFAULT '',
    http_method     TEXT        NOT NULL DEFAULT 'POST', -- GET|POST|PUT|PATCH|DELETE
    path_template   TEXT        NOT NULL DEFAULT '',     -- e.g. "/contacts/people"
    input_fields    JSONB       NOT NULL DEFAULT '[]',   -- []ActionFieldDef
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT connector_actions_pkey PRIMARY KEY (id),
    CONSTRAINT connector_actions_unique_action
        UNIQUE (connector_id, resource_name, action_key)
);

CREATE INDEX IF NOT EXISTS connector_actions_connector_id_idx
    ON connector_actions (connector_id);

COMMENT ON TABLE connector_actions IS
    'Named business actions belonging to a connector. Each row represents one operation '
    '(e.g. "Create contact" in MOCO) with its HTTP transport details and field schema.';

COMMENT ON COLUMN connector_actions.input_fields IS
    'JSON array of ActionFieldDef: '
    '[{"key":"lastname","label":"Last name","field_type":"text","required":true,'
    '"enum_values":null,"description":""}]';
