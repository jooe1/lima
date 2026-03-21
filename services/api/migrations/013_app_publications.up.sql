-- Migration: 013_app_publications.up.sql
-- Introduces first-class publication objects that bind an app version to an
-- audience set of company groups, enabling company-scoped tool discovery.

-- ---- App publications -------------------------------------------------------
CREATE TABLE app_publications (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id              uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    app_version_id      uuid NOT NULL REFERENCES app_versions(id) ON DELETE RESTRICT,
    workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    status              text NOT NULL DEFAULT 'active', -- 'active', 'archived'
    published_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    policy_profile_id   uuid, -- nullable, FK added later when policies table exists
    runtime_identity_id uuid, -- nullable, FK added later when service_principals table exists
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_app_publications_app_id ON app_publications(app_id);
CREATE INDEX idx_app_publications_company_id ON app_publications(company_id);
CREATE INDEX idx_app_publications_workspace_id ON app_publications(workspace_id);

-- ---- Publication audiences --------------------------------------------------
CREATE TABLE app_publication_audiences (
    publication_id uuid NOT NULL REFERENCES app_publications(id) ON DELETE CASCADE,
    group_id       uuid NOT NULL REFERENCES company_groups(id) ON DELETE CASCADE,
    capability     text NOT NULL DEFAULT 'use', -- 'discover', 'use'
    PRIMARY KEY (publication_id, group_id, capability)
);

CREATE INDEX idx_pub_audiences_group_id ON app_publication_audiences(group_id);

-- ---- Backfill: create publications for currently published apps --------------
-- For every app that is currently published, create an active publication
-- pinned to the most recent version snapshot. The app creator is used as
-- published_by since no earlier publisher context is available.
INSERT INTO app_publications (app_id, app_version_id, workspace_id, company_id, status, published_by)
SELECT
    a.id,
    av.id,
    a.workspace_id,
    w.company_id,
    'active',
    a.created_by
FROM apps a
JOIN workspaces w ON w.id = a.workspace_id
JOIN app_versions av ON av.app_id = a.id
WHERE a.status = 'published'
  AND av.id = (
      SELECT av2.id FROM app_versions av2
      WHERE av2.app_id = a.id
      ORDER BY av2.published_at DESC
      LIMIT 1
  )
ON CONFLICT DO NOTHING;
