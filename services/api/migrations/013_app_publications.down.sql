-- Migration: 013_app_publications.down.sql
-- Drops audience rows first (FK to app_publications), then the publications table.

DROP TABLE IF EXISTS app_publication_audiences;
DROP TABLE IF EXISTS app_publications;
