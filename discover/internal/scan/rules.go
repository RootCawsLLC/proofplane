// Package scan finds AI usage in a source tree.
//
// The design constraint that shapes everything here: an inventory entry is worthless unless it
// says where it came from. Every finding carries a file, a line, and the matched text, so a
// reader can disagree with the tool by opening the file. An AIBOM that asserts "this system uses
// claude-sonnet-5" without saying which line said so is the same attestation habit the rest of
// this repository exists to refuse.
package scan

import "regexp"

// Kind classifies what was found. These map onto CycloneDX component types in the aibom package.
type Kind string

const (
	KindModel      Kind = "model"          // a specific model identifier
	KindSDK        Kind = "sdk"            // a client library for a model provider
	KindMCP        Kind = "mcp-server"     // a declared Model Context Protocol server
	KindCredential Kind = "credential-ref" // a reference to a provider credential, never its value
	KindCloud      Kind = "cloud-resource" // a managed AI resource declared in infrastructure code
)

// Rule is one detection. Files narrows which paths it applies to; Pattern's first capture group
// is the name of the thing found.
type Rule struct {
	ID      string
	Kind    Kind
	Desc    string
	Files   *regexp.Regexp
	Pattern *regexp.Regexp
}

var (
	anyFile      = regexp.MustCompile(`.*`)
	manifestFile = regexp.MustCompile(`(?i)(^|[\\/])(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|go\.mod|Gemfile|pom\.xml)$`)
	configFile   = regexp.MustCompile(`(?i)\.(json|ya?ml|toml|env|ini|cfg|properties)$|(^|[\\/])\.env`)
	iacFile      = regexp.MustCompile(`(?i)\.(tf|tfvars|bicep)$|(^|[\\/])(template|cloudformation)[\w.-]*\.(ya?ml|json)$`)
	sourceFile   = regexp.MustCompile(`(?i)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|cs|rs|php|kt|swift)$`)
)

// Rules is the detection set.
//
// Deliberately conservative on credentials: patterns match the NAME of a provider credential
// variable, never a value that looks like a key. A scanner that reports secrets is a scanner
// whose own output is a secret, and this one writes its output to a committed file.
var Rules = []Rule{
	{
		ID:      "AID-001",
		Kind:    KindModel,
		Desc:    "Anthropic model identifier",
		Files:   anyFile,
		Pattern: regexp.MustCompile(`\b(claude-(?:opus|sonnet|haiku|fable|instant)[\w.-]*)`),
	},
	{
		ID:      "AID-002",
		Kind:    KindModel,
		Desc:    "OpenAI model identifier",
		Files:   anyFile,
		Pattern: regexp.MustCompile(`\b(gpt-[0-9][\w.-]*|o[134]-(?:mini|preview)[\w.-]*|text-embedding-[\w.-]+)`),
	},
	{
		ID:      "AID-003",
		Kind:    KindModel,
		Desc:    "Other frontier or open-weight model identifier",
		Files:   anyFile,
		Pattern: regexp.MustCompile(`\b(gemini-[\w.-]+|llama-?[0-9][\w.-]*|mistral-[\w.-]+|command-r[\w.-]*|deepseek-[\w.-]+)`),
	},
	{
		ID:      "AID-010",
		Kind:    KindSDK,
		Desc:    "Model provider SDK declared as a dependency",
		Files:   manifestFile,
		Pattern: regexp.MustCompile(`["'\s](@anthropic-ai/sdk|openai|anthropic|langchain[\w.-]*|llamaindex|@langchain/[\w.-]+|cohere-ai|@google/gener\w+ai|litellm|instructor|ollama)["'\s:=]`),
	},
	{
		ID:      "AID-011",
		Kind:    KindSDK,
		Desc:    "Model provider SDK imported in source",
		Files:   sourceFile,
		Pattern: regexp.MustCompile(`(?:import|require|from)\s*\(?\s*["']?(@anthropic-ai/sdk|openai|anthropic|langchain[\w./-]*|@langchain/[\w.-]+|cohere|litellm|ollama)\b`),
	},
	{
		ID:      "AID-020",
		Kind:    KindMCP,
		Desc:    "Model Context Protocol server package",
		Files:   configFile,
		Pattern: regexp.MustCompile(`["'](@modelcontextprotocol/[\w.-]+|mcp-server-[\w.-]+)["']`),
	},
	{
		ID:   "AID-021",
		Kind: KindMCP,
		Desc: "Model Context Protocol server block",
		// Reports the file as declaring MCP servers rather than trying to name each one. A
		// line-oriented scanner cannot reliably associate a server name with its block, and a
		// guessed name in an inventory is worse than an honest "this file declares servers".
		Files:   configFile,
		Pattern: regexp.MustCompile(`"(mcpServers)"\s*:`),
	},
	{
		ID:      "AID-030",
		Kind:    KindCredential,
		Desc:    "Reference to a model provider credential",
		Files:   anyFile,
		Pattern: regexp.MustCompile(`\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|COHERE_API_KEY|MISTRAL_API_KEY|AZURE_OPENAI_[A-Z_]+|HUGGINGFACE(?:HUB)?_[A-Z_]*TOKEN)\b`),
	},
	{
		ID:      "AID-040",
		Kind:    KindCloud,
		Desc:    "Managed AI resource declared in infrastructure code",
		Files:   iacFile,
		Pattern: regexp.MustCompile(`\b(aws_bedrock[\w]*|aws_sagemaker[\w]*|azurerm_cognitive[\w]*|google_vertex_ai[\w]*|AWS::Bedrock::[\w]+|AWS::SageMaker::[\w]+)\b`),
	},
}

// SkipDirs are never walked. Vendored trees would otherwise dominate the inventory with
// dependencies of dependencies, which is a different question from what this system uses.
var SkipDirs = map[string]bool{
	".git": true, "node_modules": true, "dist": true, "build": true, "vendor": true,
	"__pycache__": true, ".venv": true, "venv": true, ".mypy_cache": true, ".pytest_cache": true,
	"target": false, // Go/Rust "target" collides with this repo's own target/; walked on purpose.
}
