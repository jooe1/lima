package handler

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/lima/api/internal/model"
	"github.com/lima/api/internal/store"
	"go.uber.org/zap"
)

// SetManagedTableColumns handles PUT .../connectors/:id/columns.
// Replaces all column definitions for a Lima Table connector.
func SetManagedTableColumns(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")

		conn, err := s.GetConnector(r.Context(), workspaceID, connectorID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		if conn.Type != model.ConnectorTypeManaged {
			respondErr(w, http.StatusUnprocessableEntity, "wrong_type",
				fmt.Sprintf("columns endpoint is only for managed connectors, got %s", conn.Type))
			return
		}

		var body struct {
			Columns []model.ManagedTableColumn `json:"columns"`
		}
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if len(body.Columns) == 0 {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", "at least one column is required")
			return
		}
		for i, col := range body.Columns {
			if col.Name == "" {
				respondErr(w, http.StatusUnprocessableEntity, "validation_error",
					fmt.Sprintf("column %d is missing a name", i))
				return
			}
		}

		if err := s.SetManagedTableColumns(r.Context(), connectorID, body.Columns); err != nil {
			log.Error("set managed table columns", zap.String("connector_id", connectorID), zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to save columns")
			return
		}

		// Refresh schema_cache so the builder can read column names immediately.
		cols, _ := s.GetManagedTableColumns(r.Context(), connectorID)
		colMaps := make([]map[string]any, len(cols))
		for i, c := range cols {
			colMaps[i] = map[string]any{"name": c.Name, "col_type": c.ColType, "nullable": c.Nullable}
		}
		if schemaJSON, merr := json.Marshal(map[string]any{
			"type":    "managed",
			"columns": colMaps,
		}); merr == nil {
			if err := s.UpdateConnectorSchema(r.Context(), connectorID, schemaJSON); err != nil {
				log.Warn("failed to update schema_cache after SetManagedTableColumns", zap.Error(err))
			}
		}

		respond(w, http.StatusOK, map[string]any{"columns": cols})
	}
}

// ListManagedTableRows handles GET .../connectors/:id/rows.
func ListManagedTableRows(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")

		conn, err := s.GetConnector(r.Context(), workspaceID, connectorID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		if conn.Type != model.ConnectorTypeManaged {
			respondErr(w, http.StatusUnprocessableEntity, "wrong_type", "rows endpoint is only for managed connectors")
			return
		}

		rows, err := s.ListManagedTableRows(r.Context(), connectorID)
		if err != nil {
			log.Error("list managed rows", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to list rows")
			return
		}
		if rows == nil {
			rows = []model.ManagedTableRow{}
		}
		respond(w, http.StatusOK, map[string]any{"rows": rows, "row_count": len(rows)})
	}
}

// InsertManagedTableRow handles POST .../connectors/:id/rows.
func InsertManagedTableRow(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")
		claims, _ := ClaimsFromContext(r.Context())

		conn, err := s.GetConnector(r.Context(), workspaceID, connectorID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		if conn.Type != model.ConnectorTypeManaged {
			respondErr(w, http.StatusUnprocessableEntity, "wrong_type", "rows endpoint is only for managed connectors")
			return
		}

		var body struct {
			Data map[string]any `json:"data"`
		}
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if len(body.Data) == 0 {
			respondErr(w, http.StatusUnprocessableEntity, "validation_error", "data is required")
			return
		}

		row, err := s.InsertManagedTableRow(r.Context(), connectorID, claims.UserID, body.Data)
		if err != nil {
			log.Error("insert managed row", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to insert row")
			return
		}
		respond(w, http.StatusCreated, map[string]any{"row": row})
	}
}

// UpdateManagedTableRow handles PATCH .../connectors/:id/rows/:rowID.
func UpdateManagedTableRow(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")
		rowID := chi.URLParam(r, "rowID")

		conn, err := s.GetConnector(r.Context(), workspaceID, connectorID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		if conn.Type != model.ConnectorTypeManaged {
			respondErr(w, http.StatusUnprocessableEntity, "wrong_type", "rows endpoint is only for managed connectors")
			return
		}

		var body struct {
			Data map[string]any `json:"data"`
		}
		if err := decodeJSON(r, &body); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}

		row, err := s.UpdateManagedTableRow(r.Context(), connectorID, rowID, body.Data)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		respond(w, http.StatusOK, map[string]any{"row": row})
	}
}

// DeleteManagedTableRow handles DELETE .../connectors/:id/rows/:rowID.
func DeleteManagedTableRow(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")
		rowID := chi.URLParam(r, "rowID")

		conn, err := s.GetConnector(r.Context(), workspaceID, connectorID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		if conn.Type != model.ConnectorTypeManaged {
			respondErr(w, http.StatusUnprocessableEntity, "wrong_type", "rows endpoint is only for managed connectors")
			return
		}

		if err := s.DeleteManagedTableRow(r.Context(), connectorID, rowID); err != nil {
			handleStoreErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// SeedManagedTableFromCSV handles POST .../connectors/:id/seed.
// Parses a multipart CSV upload and bulk-inserts all rows.
// Columns are auto-detected from the header row and always replaced.
// Pass ?replace=true to soft-delete all existing rows before inserting.
func SeedManagedTableFromCSV(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")
		claims, _ := ClaimsFromContext(r.Context())

		conn, err := s.GetConnector(r.Context(), workspaceID, connectorID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		if conn.Type != model.ConnectorTypeManaged {
			respondErr(w, http.StatusUnprocessableEntity, "wrong_type",
				fmt.Sprintf("seed is only supported for managed connectors, got %s", conn.Type))
			return
		}

		if err := r.ParseMultipartForm(32 << 20); err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", "failed to parse multipart form")
			return
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			respondErr(w, http.StatusBadRequest, "bad_request", `"file" field is required`)
			return
		}
		defer file.Close()

		reader := csv.NewReader(file)
		reader.TrimLeadingSpace = true
		reader.LazyQuotes = true

		records, err := reader.ReadAll()
		if err != nil {
			respondErr(w, http.StatusUnprocessableEntity, "parse_error", "failed to parse CSV: "+err.Error())
			return
		}
		if len(records) == 0 {
			respondErr(w, http.StatusUnprocessableEntity, "empty_file", "CSV file is empty")
			return
		}

		headers := records[0]
		dataRows := records[1:]

		// Replace column definitions from CSV headers.
		colDefs := make([]model.ManagedTableColumn, len(headers))
		for i, h := range headers {
			colDefs[i] = model.ManagedTableColumn{Name: h, ColType: "text", Nullable: true}
		}
		if err := s.SetManagedTableColumns(r.Context(), connectorID, colDefs); err != nil {
			log.Error("set columns during seed", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to set columns")
			return
		}

		// ?replace=true soft-deletes all existing rows before inserting new ones.
		if r.URL.Query().Get("replace") == "true" {
			if err := s.DeleteAllManagedTableRows(r.Context(), connectorID); err != nil {
				log.Error("delete rows before seed replace", zap.Error(err))
				respondErr(w, http.StatusInternalServerError, "db_error", "failed to clear existing rows")
				return
			}
		}

		inserted := 0
		for _, rec := range dataRows {
			rowData := make(map[string]any, len(headers))
			for i, h := range headers {
				if i < len(rec) {
					rowData[h] = rec[i]
				} else {
					rowData[h] = nil
				}
			}
			if _, err := s.InsertManagedTableRow(r.Context(), connectorID, claims.UserID, rowData); err != nil {
				log.Error("insert row during seed", zap.Error(err))
				respondErr(w, http.StatusInternalServerError, "db_error", "failed to insert rows")
				return
			}
			inserted++
		}

		// Refresh schema_cache.
		colMaps := make([]map[string]any, len(colDefs))
		for i, c := range colDefs {
			colMaps[i] = map[string]any{"name": c.Name, "col_type": c.ColType, "nullable": c.Nullable}
		}
		if schemaJSON, merr := json.Marshal(map[string]any{
			"type":       "managed",
			"columns":    colMaps,
			"total_rows": inserted,
		}); merr == nil {
			_ = s.UpdateConnectorSchema(r.Context(), connectorID, schemaJSON)
		}

		respond(w, http.StatusOK, map[string]any{
			"columns":       headers,
			"rows_inserted": inserted,
		})
	}
}

// ExportManagedTableCSV handles GET .../connectors/:id/export.csv.
// Streams all live rows as a CSV file download.
func ExportManagedTableCSV(s *store.Store, log *zap.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspaceID := chi.URLParam(r, "workspaceID")
		connectorID := chi.URLParam(r, "connectorID")

		conn, err := s.GetConnector(r.Context(), workspaceID, connectorID)
		if err != nil {
			handleStoreErr(w, err)
			return
		}
		if conn.Type != model.ConnectorTypeManaged {
			respondErr(w, http.StatusUnprocessableEntity, "wrong_type", "export is only for managed connectors")
			return
		}

		cols, err := s.GetManagedTableColumns(r.Context(), connectorID)
		if err != nil {
			log.Error("get columns for export", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to load columns")
			return
		}
		rows, err := s.ListManagedTableRows(r.Context(), connectorID)
		if err != nil {
			log.Error("list rows for export", zap.Error(err))
			respondErr(w, http.StatusInternalServerError, "db_error", "failed to load rows")
			return
		}

		headers := make([]string, len(cols))
		for i, c := range cols {
			headers[i] = c.Name
		}

		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition",
			fmt.Sprintf(`attachment; filename="%s.csv"`, conn.Name))
		w.WriteHeader(http.StatusOK)

		cw := csv.NewWriter(w)
		_ = cw.Write(headers)
		for _, row := range rows {
			rec := make([]string, len(headers))
			for i, h := range headers {
				if v, ok := row.Data[h]; ok && v != nil {
					rec[i] = fmt.Sprintf("%v", v)
				}
			}
			_ = cw.Write(rec)
		}
		cw.Flush()
	}
}
