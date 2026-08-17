package aibom

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/RootCawsLLC/proofplane/discover/internal/scan"
)

func fixture(t *testing.T) *scan.Result {
	t.Helper()
	result, err := scan.Run(scan.Options{
		Root:    filepath.Join("..", "..", "testdata", "sample"),
		Workers: 4,
	})
	if err != nil {
		t.Fatalf("scan failed: %v", err)
	}
	return result
}

func TestOutputIsByteIdentical(t *testing.T) {
	// An inventory that churns on every run is one nobody reads, and a diff that always shows
	// changes cannot show a change in the AI surface.
	result := fixture(t)
	a, err := json.Marshal(Build(result, "sample", nil))
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(Build(result, "sample", nil))
	if err != nil {
		t.Fatal(err)
	}
	if string(a) != string(b) {
		t.Fatal("two builds of the same scan produced different bytes")
	}
}

func TestCredentialsAreNotComponents(t *testing.T) {
	// A bill of materials listing credential variable names is a map for whoever obtains it.
	// They belong in run metadata as evidence a provider is in use, not in the asset list.
	bom := Build(fixture(t), "sample", nil)
	for _, c := range bom.Components {
		if c.Name == "ANTHROPIC_API_KEY" || c.Name == "OPENAI_API_KEY" {
			t.Errorf("credential reference emitted as a component: %+v", c)
		}
	}

	var found bool
	for _, p := range bom.Metadata.Properties {
		if p.Name == "proofplane:provider-credentials-referenced" && p.Value != "" {
			found = true
		}
	}
	if !found {
		t.Error("expected referenced credential names in metadata")
	}
}

func TestComponentTypesMapToCycloneDX(t *testing.T) {
	bom := Build(fixture(t), "sample", nil)
	want := map[string]string{
		"claude-sonnet-5":   "machine-learning-model",
		"@anthropic-ai/sdk": "library",
		"mcpServers":        "service",
	}
	got := map[string]string{}
	for _, c := range bom.Components {
		got[c.Name] = c.Type
	}
	for name, typ := range want {
		if got[name] != typ {
			t.Errorf("%s: want type %q, got %q", name, typ, got[name])
		}
	}
}

func TestEveryComponentCarriesEvidence(t *testing.T) {
	for _, c := range Build(fixture(t), "sample", nil).Components {
		var hasEvidence bool
		for _, p := range c.Properties {
			if p.Name == "proofplane:evidence" {
				hasEvidence = true
			}
		}
		if !hasEvidence {
			t.Errorf("component %q has no evidence property", c.Name)
		}
	}
}

func TestUndeclaredIsEverythingWhenNothingIsSanctioned(t *testing.T) {
	bom := Build(fixture(t), "sample", nil)
	if len(Undeclared(bom)) != len(bom.Components) {
		t.Errorf("with an empty declared list every component should read undeclared: %d of %d",
			len(Undeclared(bom)), len(bom.Components))
	}
}

func TestDeclaringAComponentClearsIt(t *testing.T) {
	declared := map[string]bool{"claude-sonnet-5": true}
	bom := Build(fixture(t), "sample", declared)
	for _, c := range Undeclared(bom) {
		if c.Name == "claude-sonnet-5" {
			t.Error("a declared component still reports as undeclared")
		}
	}
	if len(Undeclared(bom)) != len(bom.Components)-1 {
		t.Errorf("expected exactly one fewer undeclared component")
	}
}

func TestSerialNumberTracksContent(t *testing.T) {
	result := fixture(t)
	base := Build(result, "sample", nil)

	// Drop a specific component rather than the last finding. Findings are not one-to-one with
	// components — credentials are excluded and repeated occurrences group — so trimming the
	// tail of the slice frequently leaves the component set unchanged, and an unchanged
	// component set SHOULD produce the same serial.
	var kept []scan.Finding
	for _, f := range result.Findings {
		if f.Name != "claude-sonnet-5" {
			kept = append(kept, f)
		}
	}
	if len(kept) == len(result.Findings) {
		t.Fatal("fixture no longer contains claude-sonnet-5; test needs updating")
	}

	changed := Build(&scan.Result{
		Root:         result.Root,
		FilesScanned: result.FilesScanned,
		Findings:     kept,
	}, "sample", nil)

	if len(changed.Components) >= len(base.Components) {
		t.Fatalf("expected fewer components after dropping one: %d vs %d",
			len(changed.Components), len(base.Components))
	}
	if base.SerialNumber == changed.SerialNumber {
		t.Error("a different component set produced the same serial number")
	}
}

func TestSerialNumberIsStableWhenTheComponentSetIsUnchanged(t *testing.T) {
	result := fixture(t)
	base := Build(result, "sample", nil)
	// Same components, different scan statistics — the serial identifies the AI surface, not
	// the run, so it must not move.
	same := Build(&scan.Result{
		Root:         result.Root,
		FilesScanned: result.FilesScanned + 100,
		Findings:     result.Findings,
	}, "sample", nil)
	if base.SerialNumber != same.SerialNumber {
		t.Error("serial number moved without the component set changing")
	}
}

func TestSpecVersionIsSixteen(t *testing.T) {
	bom := Build(fixture(t), "sample", nil)
	if bom.BOMFormat != "CycloneDX" || bom.SpecVersion != "1.6" {
		t.Errorf("want CycloneDX 1.6, got %s %s", bom.BOMFormat, bom.SpecVersion)
	}
}
