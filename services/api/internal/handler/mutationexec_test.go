package handler

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/lima/api/internal/model"
)

type managedMutationStoreStub struct {
	rows         []model.ManagedTableRow
	insertedData []map[string]any
	updatedRows  []managedMutationUpdateCall
	deletedIDs   []string
	listErr      error
	insertErr    error
	updateErr    error
	deleteErr    error
}

type managedMutationUpdateCall struct {
	rowID string
	data  map[string]any
}

func (s *managedMutationStoreStub) InsertManagedTableRow(_ context.Context, _ string, _ string, data map[string]any) (*model.ManagedTableRow, error) {
	if s.insertErr != nil {
		return nil, s.insertErr
	}
	cloned := cloneManagedRowData(data)
	s.insertedData = append(s.insertedData, cloned)
	row := model.ManagedTableRow{ID: "row-inserted", ConnectorID: "conn-1", Data: cloned}
	s.rows = append(s.rows, row)
	return &row, nil
}

func (s *managedMutationStoreStub) ListManagedTableRows(_ context.Context, _ string) ([]model.ManagedTableRow, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	rows := make([]model.ManagedTableRow, 0, len(s.rows))
	for _, row := range s.rows {
		rowCopy := row
		rowCopy.Data = cloneManagedRowData(row.Data)
		rows = append(rows, rowCopy)
	}
	return rows, nil
}

func (s *managedMutationStoreStub) UpdateManagedTableRow(_ context.Context, _ string, rowID string, data map[string]any) (*model.ManagedTableRow, error) {
	if s.updateErr != nil {
		return nil, s.updateErr
	}
	cloned := cloneManagedRowData(data)
	s.updatedRows = append(s.updatedRows, managedMutationUpdateCall{rowID: rowID, data: cloned})
	for i := range s.rows {
		if s.rows[i].ID == rowID {
			s.rows[i].Data = cloned
			row := s.rows[i]
			return &row, nil
		}
	}
	row := model.ManagedTableRow{ID: rowID, ConnectorID: "conn-1", Data: cloned}
	return &row, nil
}

func (s *managedMutationStoreStub) DeleteManagedTableRow(_ context.Context, _ string, rowID string) error {
	if s.deleteErr != nil {
		return s.deleteErr
	}
	s.deletedIDs = append(s.deletedIDs, rowID)
	filtered := s.rows[:0]
	for _, row := range s.rows {
		if row.ID != rowID {
			filtered = append(filtered, row)
		}
	}
	s.rows = filtered
	return nil
}

func TestExecuteManagedMutation_UpdateMatchesRowDataAndPreservesUntouchedFields(t *testing.T) {
	t.Parallel()

	stub := &managedMutationStoreStub{
		rows: []model.ManagedTableRow{{
			ID:          "row-1",
			ConnectorID: "conn-1",
			Data: map[string]any{
				"OrderID":      123.0,
				"CustomerName": "Ada",
				"Amount":       "10",
				"Status":       "draft",
			},
			CreatedAt: time.Now(),
			UpdatedAt: time.Now(),
		}},
	}

	affected, err := executeManagedMutation(context.Background(), stub, "conn-1", `UPDATE Orders SET "CustomerName"='Smith, John', "Amount"='42' WHERE "OrderID"='123'`, "user-1")
	if err != nil {
		t.Fatalf("executeManagedMutation() error = %v", err)
	}
	if affected != 1 {
		t.Fatalf("affected rows = %d, want 1", affected)
	}
	if len(stub.updatedRows) != 1 {
		t.Fatalf("updated row calls = %d, want 1", len(stub.updatedRows))
	}
	updated := stub.updatedRows[0]
	if updated.rowID != "row-1" {
		t.Fatalf("updated row id = %q, want row-1", updated.rowID)
	}
	if got := updated.data["CustomerName"]; got != "Smith, John" {
		t.Fatalf("updated CustomerName = %v, want %q", got, "Smith, John")
	}
	if got := updated.data["Amount"]; got != "42" {
		t.Fatalf("updated Amount = %v, want 42", got)
	}
	if got := updated.data["Status"]; got != "draft" {
		t.Fatalf("updated Status = %v, want untouched field preserved", got)
	}
	if got := updated.data["OrderID"]; got != 123.0 {
		t.Fatalf("updated OrderID = %v, want original primary key preserved", got)
	}
}

func TestExecuteManagedMutation_DeleteMatchesSimpleWhereClause(t *testing.T) {
	t.Parallel()

	stub := &managedMutationStoreStub{
		rows: []model.ManagedTableRow{
			{ID: "row-1", ConnectorID: "conn-1", Data: map[string]any{"OrderID": "ord-1", "Status": "draft"}},
			{ID: "row-2", ConnectorID: "conn-1", Data: map[string]any{"OrderID": "ord-2", "Status": "draft"}},
		},
	}

	affected, err := executeManagedMutation(context.Background(), stub, "conn-1", `DELETE FROM Orders WHERE "OrderID"='ord-2'`, "user-1")
	if err != nil {
		t.Fatalf("executeManagedMutation() error = %v", err)
	}
	if affected != 1 {
		t.Fatalf("affected rows = %d, want 1", affected)
	}
	if len(stub.deletedIDs) != 1 || stub.deletedIDs[0] != "row-2" {
		t.Fatalf("deleted row ids = %v, want [row-2]", stub.deletedIDs)
	}
}

func TestExecuteManagedMutation_RejectsUnsupportedWhereClauses(t *testing.T) {
	t.Parallel()

	stub := &managedMutationStoreStub{}

	_, err := executeManagedMutation(context.Background(), stub, "conn-1", `UPDATE Orders SET "Status"='paid' WHERE "OrderID"='ord-1' AND "Status"='draft'`, "user-1")
	if err == nil {
		t.Fatal("executeManagedMutation() error = nil, want unsupported WHERE error")
	}
	if !strings.Contains(err.Error(), "single equality WHERE clause") {
		t.Fatalf("executeManagedMutation() error = %v, want single equality WHERE clause guidance", err)
	}
}
