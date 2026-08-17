// Package aibom renders scan findings as a CycloneDX 1.6 AI/ML bill of materials.
//
// Two properties matter more than the format:
//
//   - Every component carries the file and line that produced it. An inventory entry a reader
//     cannot trace back to a line of source is an assertion, and this repository does not ship
//     those.
//   - Output is deterministic. Same tree, same bytes — so an AIBOM committed to a repository
//     produces a reviewable diff when the AI surface changes, and no diff when it does not.
//     An inventory that churns on every run is one nobody reads.
package aibom

import (
	"crypto/sha1" //nolint:gosec // RFC 4122 v5 requires SHA-1; not used as a security primitive
	"encoding/hex"
	"fmt"
	"sort"
	"strings"

	"github.com/RootCawsLLC/proofplane/discover/internal/scan"
)

const specVersion = "1.6"

// namespace is the RFC 4122 DNS namespace, used so identical input re-serialises identically.
var namespace = [16]byte{
	0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1,
	0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
}

type Property struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type Component struct {
	Type        string     `json:"type"`
	BomRef      string     `json:"bom-ref"`
	Name        string     `json:"name"`
	Version     string     `json:"version,omitempty"`
	Description string     `json:"description,omitempty"`
	Properties  []Property `json:"properties,omitempty"`
}

type Metadata struct {
	Component  Component  `json:"component"`
	Properties []Property `json:"properties,omitempty"`
}

type BOM struct {
	BOMFormat    string      `json:"bomFormat"`
	SpecVersion  string      `json:"specVersion"`
	SerialNumber string      `json:"serialNumber"`
	Version      int         `json:"version"`
	Metadata     Metadata    `json:"metadata"`
	Components   []Component `json:"components"`
}

// componentType maps a finding kind onto a CycloneDX component type.
//
// Credential references are deliberately NOT emitted as components. They are evidence that a
// provider is in use, recorded as a property on the run, not assets in their own right — and a
// bill of materials listing credential names is a map for anyone who obtains it.
func componentType(k scan.Kind) string {
	switch k {
	case scan.KindModel:
		return "machine-learning-model"
	case scan.KindSDK:
		return "library"
	case scan.KindMCP:
		return "service"
	case scan.KindCloud:
		return "platform"
	default:
		return "application"
	}
}

func uuidV5(name string) string {
	h := sha1.New() //nolint:gosec // see note on namespace
	h.Write(namespace[:])
	h.Write([]byte(name))
	sum := h.Sum(nil)
	b := make([]byte, 16)
	copy(b, sum[:16])
	b[6] = (b[6] & 0x0f) | 0x50
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b)
	return fmt.Sprintf("%s-%s-%s-%s-%s", s[0:8], s[8:12], s[12:16], s[16:20], s[20:32])
}

type key struct {
	kind scan.Kind
	name string
}

// Build renders a scan result as a bill of materials.
//
// declared is the set of names an operator has sanctioned. Anything found and not declared is
// marked undeclared — the same question PP-C008 asks about tools, asked about models and SDKs.
// An empty declared set means "nothing is sanctioned yet", and everything is flagged, which is
// the honest starting position for a first scan rather than a bug.
func Build(result *scan.Result, projectName string, declared map[string]bool) BOM {
	grouped := map[key][]scan.Finding{}
	credentials := map[string]bool{}

	for _, f := range result.Findings {
		if f.Kind == scan.KindCredential {
			credentials[f.Name] = true
			continue
		}
		k := key{f.Kind, f.Name}
		grouped[k] = append(grouped[k], f)
	}

	keys := make([]key, 0, len(grouped))
	for k := range grouped {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].kind != keys[j].kind {
			return keys[i].kind < keys[j].kind
		}
		return keys[i].name < keys[j].name
	})

	components := make([]Component, 0, len(keys))
	undeclared := 0

	for _, k := range keys {
		findings := grouped[k]
		sort.Slice(findings, func(i, j int) bool {
			if findings[i].File != findings[j].File {
				return findings[i].File < findings[j].File
			}
			return findings[i].Line < findings[j].Line
		})

		ref := fmt.Sprintf("%s/%s", k.kind, k.name)
		props := []Property{
			{Name: "proofplane:kind", Value: string(k.kind)},
			{Name: "proofplane:occurrences", Value: fmt.Sprint(len(findings))},
			{Name: "proofplane:rule", Value: findings[0].RuleID},
		}

		isDeclared := declared[k.name]
		props = append(props, Property{
			Name:  "proofplane:declared",
			Value: fmt.Sprint(isDeclared),
		})
		if !isDeclared {
			undeclared++
		}

		// Cap the evidence list. Ten call sites establish use; two hundred establish it no
		// harder and make the document unreadable.
		limit := len(findings)
		if limit > 10 {
			limit = 10
		}
		for _, f := range findings[:limit] {
			props = append(props, Property{
				Name:  "proofplane:evidence",
				Value: fmt.Sprintf("%s:%d", f.File, f.Line),
			})
		}
		if len(findings) > limit {
			props = append(props, Property{
				Name:  "proofplane:evidence-truncated",
				Value: fmt.Sprintf("%d further occurrence(s) not listed", len(findings)-limit),
			})
		}

		version := ""
		if k.kind == scan.KindModel {
			// The identifier is the version. Whether it is PINNED is PP-C006's question, and
			// this does not answer it — it records what the source says.
			version = k.name
		}

		components = append(components, Component{
			Type:        componentType(k.kind),
			BomRef:      ref,
			Name:        k.name,
			Version:     version,
			Description: findings[0].Excerpt,
			Properties:  props,
		})
	}

	credNames := make([]string, 0, len(credentials))
	for name := range credentials {
		credNames = append(credNames, name)
	}
	sort.Strings(credNames)

	meta := Metadata{
		Component: Component{
			Type:        "application",
			BomRef:      projectName,
			Name:        projectName,
			Description: "AI surface discovered by static scan of the source tree.",
		},
		Properties: []Property{
			{Name: "proofplane:files-scanned", Value: fmt.Sprint(result.FilesScanned)},
			{Name: "proofplane:files-skipped", Value: fmt.Sprint(result.FilesSkipped)},
			{Name: "proofplane:components", Value: fmt.Sprint(len(components))},
			{Name: "proofplane:undeclared", Value: fmt.Sprint(undeclared)},
			{Name: "proofplane:provider-credentials-referenced",
				Value: strings.Join(credNames, ",")},
		},
	}

	serialSeed := projectName
	for _, c := range components {
		serialSeed += "|" + c.BomRef
	}

	return BOM{
		BOMFormat:    "CycloneDX",
		SpecVersion:  specVersion,
		SerialNumber: "urn:uuid:" + uuidV5(serialSeed),
		Version:      1,
		Metadata:     meta,
		Components:   components,
	}
}

// Undeclared returns components not on the sanctioned list — the shadow-AI signal.
func Undeclared(b BOM) []Component {
	var out []Component
	for _, c := range b.Components {
		for _, p := range c.Properties {
			if p.Name == "proofplane:declared" && p.Value == "false" {
				out = append(out, c)
			}
		}
	}
	return out
}
