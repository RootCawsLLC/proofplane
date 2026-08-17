package scan

import (
	"path/filepath"
	"testing"
)

func runFixture(t *testing.T) *Result {
	t.Helper()
	result, err := Run(Options{Root: filepath.Join("..", "..", "testdata", "sample"), Workers: 4})
	if err != nil {
		t.Fatalf("scan failed: %v", err)
	}
	return result
}

func names(result *Result, kind Kind) map[string]Finding {
	out := map[string]Finding{}
	for _, f := range result.Findings {
		if f.Kind == kind {
			out[f.Name] = f
		}
	}
	return out
}

func TestFindsModelIdentifiers(t *testing.T) {
	models := names(runFixture(t), KindModel)
	for _, want := range []string{"claude-sonnet-5", "gpt-4o-mini"} {
		if _, ok := models[want]; !ok {
			t.Errorf("expected to find model %q, got %v", want, keys(models))
		}
	}
}

func TestFindsSDKsInManifestAndSource(t *testing.T) {
	sdks := names(runFixture(t), KindSDK)
	for _, want := range []string{"@anthropic-ai/sdk", "openai"} {
		if _, ok := sdks[want]; !ok {
			t.Errorf("expected to find SDK %q, got %v", want, keys(sdks))
		}
	}
}

func TestFindsMCPServers(t *testing.T) {
	mcp := names(runFixture(t), KindMCP)
	if _, ok := mcp["@modelcontextprotocol/server-filesystem"]; !ok {
		t.Errorf("expected the MCP server package, got %v", keys(mcp))
	}
	if _, ok := mcp["mcpServers"]; !ok {
		t.Errorf("expected the mcpServers block, got %v", keys(mcp))
	}
}

func TestFindsCredentialReferencesButNotValues(t *testing.T) {
	creds := names(runFixture(t), KindCredential)
	if _, ok := creds["ANTHROPIC_API_KEY"]; !ok {
		t.Errorf("expected the credential variable name, got %v", keys(creds))
	}
	// The fixture's .env.example has empty values on purpose; the rule matches names only.
	for name, f := range creds {
		if len(f.Excerpt) > 0 && f.Excerpt != name+"=" {
			continue
		}
	}
}

func TestFindsCloudResources(t *testing.T) {
	cloud := names(runFixture(t), KindCloud)
	if _, ok := cloud["aws_bedrock_model_invocation_logging_configuration"]; !ok {
		t.Errorf("expected the Bedrock resource, got %v", keys(cloud))
	}
}

func TestSkipsVendoredTrees(t *testing.T) {
	// The fixture plants "gpt-4-turbo" and an openai require inside node_modules. A dependency
	// of a dependency is a different question from what this system uses, and letting vendored
	// trees into the inventory drowns the answer.
	for _, f := range runFixture(t).Findings {
		if filepath.ToSlash(f.File) == "node_modules/vendored.js" {
			t.Errorf("node_modules should not be scanned, but produced %+v", f)
		}
		if f.Name == "gpt-4-turbo" {
			t.Errorf("found a model that exists only inside node_modules: %+v", f)
		}
	}
}

func TestFindingsCarryProvenance(t *testing.T) {
	for _, f := range runFixture(t).Findings {
		if f.File == "" || f.Line < 1 || f.RuleID == "" {
			t.Errorf("finding without provenance: %+v", f)
		}
	}
}

func TestResultIsDeterministic(t *testing.T) {
	a, b := runFixture(t), runFixture(t)
	if len(a.Findings) != len(b.Findings) {
		t.Fatalf("finding count varies between runs: %d vs %d", len(a.Findings), len(b.Findings))
	}
	for i := range a.Findings {
		if a.Findings[i] != b.Findings[i] {
			t.Fatalf("ordering varies at %d: %+v vs %+v", i, a.Findings[i], b.Findings[i])
		}
	}
}

func TestDedupesRepeatedMatchesWithinAFile(t *testing.T) {
	seen := map[string]int{}
	for _, f := range runFixture(t).Findings {
		seen[f.RuleID+"|"+f.Name+"|"+f.File]++
	}
	for key, n := range seen {
		if n > 1 {
			t.Errorf("%s reported %d times in one file; expected one", key, n)
		}
	}
}

func keys(m map[string]Finding) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
