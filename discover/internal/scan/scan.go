package scan

import (
	"bufio"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

// MaxFileBytes caps what is read. Anything larger is almost certainly generated, vendored, or a
// binary, and none of those answer the question "what does this system use".
const MaxFileBytes = 2 << 20 // 2 MiB

// MaxLineBytes guards against minified bundles, where a single "line" can be megabytes.
const MaxLineBytes = 64 << 10

// Finding is one detection, carrying enough provenance for a reader to disagree with it.
type Finding struct {
	RuleID  string `json:"rule_id"`
	Kind    Kind   `json:"kind"`
	Name    string `json:"name"`
	File    string `json:"file"`
	Line    int    `json:"line"`
	Excerpt string `json:"excerpt"`
}

// Result is the whole scan.
type Result struct {
	Root         string    `json:"root"`
	FilesScanned int       `json:"files_scanned"`
	FilesSkipped int       `json:"files_skipped"`
	Findings     []Finding `json:"findings"`
}

type Options struct {
	Root    string
	Workers int
	// Exclude holds path prefixes and globs (matched against slash-separated relative paths)
	// that are walked but not scanned.
	//
	// This exists because of a false positive the tool found in itself. Scanning this repository
	// reported one of the open-weight model identifiers as part of its AI surface, sourced from
	// the regex in rules.go that exists to detect that identifier. Any repository containing
	// model documentation, test fixtures, or detection rules has the same problem, and
	// pretending otherwise makes the inventory quietly wrong rather than loudly incomplete.
	//
	// Note the identifier is described rather than written here. A comment naming it would
	// reintroduce the same false positive in the file explaining the false positive, which is
	// how the third iteration of this was found.
	Exclude []string
}

func excluded(rel string, patterns []string) bool {
	for _, p := range patterns {
		if p == "" {
			continue
		}
		if strings.HasPrefix(rel, strings.TrimSuffix(p, "/")+"/") || rel == p {
			return true
		}
		if ok, err := filepath.Match(p, rel); err == nil && ok {
			return true
		}
		if ok, err := filepath.Match(p, filepath.Base(rel)); err == nil && ok {
			return true
		}
	}
	return false
}

// Run walks Root and applies every rule to every eligible file.
//
// Concurrency is a worker pool over files rather than over rules: file reads dominate, rules are
// cheap, and per-file work is naturally independent. This is the shape of problem Go is actually
// good at, which is why this component is written in Go and the rest of the harness is not.
func Run(opts Options) (*Result, error) {
	if opts.Workers <= 0 {
		opts.Workers = runtime.NumCPU()
	}
	root, err := filepath.Abs(opts.Root)
	if err != nil {
		return nil, fmt.Errorf("resolving root: %w", err)
	}

	paths := make(chan string, 256)
	results := make(chan []Finding, 256)

	var (
		scanned int
		skipped int
		mu      sync.Mutex
	)

	var wg sync.WaitGroup
	for i := 0; i < opts.Workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for path := range paths {
				found, err := scanFile(root, path, opts.Exclude)
				mu.Lock()
				if err != nil {
					skipped++
				} else {
					scanned++
				}
				mu.Unlock()
				if len(found) > 0 {
					results <- found
				}
			}
		}()
	}

	done := make(chan struct{})
	all := make([]Finding, 0, 64)
	go func() {
		for batch := range results {
			all = append(all, batch...)
		}
		close(done)
	}()

	walkErr := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// An unreadable directory is a gap in coverage, not a reason to abandon the scan.
			// It is counted so the summary cannot imply completeness it does not have.
			mu.Lock()
			skipped++
			mu.Unlock()
			return nil //nolint:nilerr // deliberate: keep walking
		}
		if d.IsDir() {
			if path != root && SkipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() > MaxFileBytes || !info.Mode().IsRegular() {
			mu.Lock()
			skipped++
			mu.Unlock()
			return nil
		}
		paths <- path
		return nil
	})

	close(paths)
	wg.Wait()
	close(results)
	<-done

	if walkErr != nil {
		return nil, fmt.Errorf("walking %s: %w", root, walkErr)
	}

	sort.Slice(all, func(i, j int) bool {
		if all[i].File != all[j].File {
			return all[i].File < all[j].File
		}
		if all[i].Line != all[j].Line {
			return all[i].Line < all[j].Line
		}
		return all[i].Name < all[j].Name
	})

	return &Result{Root: root, FilesScanned: scanned, FilesSkipped: skipped, Findings: all}, nil
}

func scanFile(root, path string, exclude []string) ([]Finding, error) {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		rel = path
	}
	rel = filepath.ToSlash(rel)

	if excluded(rel, exclude) {
		return nil, nil
	}

	applicable := make([]Rule, 0, len(Rules))
	for _, rule := range Rules {
		if rule.Files.MatchString(rel) {
			applicable = append(applicable, rule)
		}
	}
	if len(applicable) == 0 {
		return nil, nil
	}

	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var found []Finding
	seen := make(map[string]bool)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64<<10), MaxLineBytes)

	for lineNo := 1; scanner.Scan(); lineNo++ {
		line := scanner.Text()
		if len(line) > MaxLineBytes {
			continue
		}
		for _, rule := range applicable {
			for _, m := range rule.Pattern.FindAllStringSubmatch(line, -1) {
				name := m[0]
				if len(m) > 1 && m[1] != "" {
					name = m[1]
				}
				// One finding per (rule, name, file). Repeating the same model identifier on
				// forty lines tells a reader nothing the first occurrence did not.
				key := rule.ID + "\x00" + name
				if seen[key] {
					continue
				}
				seen[key] = true
				found = append(found, Finding{
					RuleID:  rule.ID,
					Kind:    rule.Kind,
					Name:    name,
					File:    rel,
					Line:    lineNo,
					Excerpt: excerpt(line),
				})
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return found, err
	}
	return found, nil
}

func excerpt(line string) string {
	trimmed := strings.TrimSpace(line)
	if len(trimmed) > 160 {
		return trimmed[:157] + "..."
	}
	return trimmed
}
