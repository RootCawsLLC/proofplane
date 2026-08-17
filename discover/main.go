// Command discover inventories the AI surface of a source tree.
//
//	discover --root . --declared declared.txt --out aibom.json
//
// You cannot govern what you have not inventoried, and every other control in this repository
// is scoped to a model identifier that something has to establish. This establishes it, and
// records the line of source that says so.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/RootCawsLLC/proofplane/discover/internal/aibom"
	"github.com/RootCawsLLC/proofplane/discover/internal/scan"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(2)
	}
}

func run() error {
	var (
		root         = flag.String("root", ".", "directory to scan")
		out          = flag.String("out", "", "write the AIBOM here (default: stdout)")
		declaredPath = flag.String("declared", "", "file listing sanctioned model and SDK names, one per line")
		format       = flag.String("format", "text", "text or json")
		workers      = flag.Int("workers", 0, "concurrent file readers (default: NumCPU)")
		failUndecl   = flag.Bool("fail-on-undeclared", false, "exit non-zero if anything is undeclared")
		excludeFlag  = flag.String("exclude", "", "comma-separated paths or globs to skip (adds to .discoverignore)")
	)
	flag.Parse()

	declared, err := loadDeclared(*declaredPath)
	if err != nil {
		return err
	}

	exclude, err := loadExcludes(*root, *excludeFlag, *declaredPath)
	if err != nil {
		return err
	}

	result, err := scan.Run(scan.Options{Root: *root, Workers: *workers, Exclude: exclude})
	if err != nil {
		return err
	}

	name := filepath.Base(result.Root)
	bom := aibom.Build(result, name, declared)

	encoded, err := json.MarshalIndent(bom, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding AIBOM: %w", err)
	}
	encoded = append(encoded, '\n')

	if *out != "" {
		if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(*out, encoded, 0o644); err != nil { //nolint:gosec // inventory, not a secret
			return err
		}
	}

	switch *format {
	case "json":
		if *out == "" {
			os.Stdout.Write(encoded)
		}
	case "text":
		printSummary(result, bom, *declaredPath, *out)
	default:
		return fmt.Errorf("unknown --format %q (want text or json)", *format)
	}

	if *failUndecl && len(aibom.Undeclared(bom)) > 0 {
		return fmt.Errorf("%d undeclared AI component(s)", len(aibom.Undeclared(bom)))
	}
	return nil
}

// loadExcludes reads .discoverignore from the scan root and appends any --exclude patterns.
//
// A repository that documents models, ships detection rules, or carries test fixtures will
// otherwise report those as its own AI surface. Excluding them is a judgement the operator makes
// and records in a file, not something the tool guesses.
func loadExcludes(root, flagValue, declaredPath string) ([]string, error) {
	// Built in rather than left to .discoverignore, because they are always correct and easy to
	// forget. The ignore file names the identifiers it excludes and the declared list names the
	// ones it sanctions; scanning either makes the tool report its own configuration as the
	// system's AI surface. Found by running this against its own repository, twice.
	patterns := []string{".discoverignore"}
	if declaredPath != "" {
		if rel, err := filepath.Rel(root, declaredPath); err == nil {
			patterns = append(patterns, filepath.ToSlash(rel))
		}
		patterns = append(patterns, filepath.Base(declaredPath))
	}

	ignorePath := filepath.Join(root, ".discoverignore")
	if raw, err := os.ReadFile(ignorePath); err == nil { //nolint:gosec // path derived from --root
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			patterns = append(patterns, line)
		}
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("reading %s: %w", ignorePath, err)
	}

	for _, p := range strings.Split(flagValue, ",") {
		if p = strings.TrimSpace(p); p != "" {
			patterns = append(patterns, p)
		}
	}
	return patterns, nil
}

func loadDeclared(path string) (map[string]bool, error) {
	declared := map[string]bool{}
	if path == "" {
		return declared, nil
	}
	raw, err := os.ReadFile(path) //nolint:gosec // operator-supplied path
	if err != nil {
		return nil, fmt.Errorf("reading declared list: %w", err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		declared[line] = true
	}
	return declared, nil
}

func printSummary(result *scan.Result, bom aibom.BOM, declaredPath, outPath string) {
	fmt.Printf("root            %s\n", result.Root)
	fmt.Printf("files scanned   %d (%d skipped)\n", result.FilesScanned, result.FilesSkipped)
	fmt.Printf("findings        %d\n", len(result.Findings))
	fmt.Printf("components      %d\n", len(bom.Components))
	if declaredPath == "" {
		fmt.Printf("declared list   (none given — every component reads as undeclared)\n")
	} else {
		fmt.Printf("declared list   %s\n", declaredPath)
	}
	fmt.Println()

	byKind := map[string][]aibom.Component{}
	for _, c := range bom.Components {
		kind := ""
		declared := ""
		for _, p := range c.Properties {
			if p.Name == "proofplane:kind" {
				kind = p.Value
			}
			if p.Name == "proofplane:declared" && p.Value == "false" {
				declared = "  UNDECLARED"
			}
		}
		byKind[kind] = append(byKind[kind], c)
		_ = declared
	}

	kinds := make([]string, 0, len(byKind))
	for k := range byKind {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)

	for _, kind := range kinds {
		fmt.Printf("%s\n", kind)
		for _, c := range byKind[kind] {
			flag := ""
			evidence := ""
			occurrences := ""
			for _, p := range c.Properties {
				switch p.Name {
				case "proofplane:declared":
					if p.Value == "false" {
						flag = "  UNDECLARED"
					}
				case "proofplane:evidence":
					if evidence == "" {
						evidence = p.Value
					}
				case "proofplane:occurrences":
					occurrences = p.Value
				}
			}
			fmt.Printf("  %-34s %3sx  first seen %s%s\n", c.Name, occurrences, evidence, flag)
		}
		fmt.Println()
	}

	undeclared := aibom.Undeclared(bom)
	if len(undeclared) > 0 {
		fmt.Printf("%d component(s) not on the sanctioned list.\n", len(undeclared))
	} else {
		fmt.Println("every component is on the sanctioned list.")
	}
	if outPath != "" {
		fmt.Printf("AIBOM written to %s\n", outPath)
	}
}
