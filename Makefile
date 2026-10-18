.PHONY: build build-frontend install dev test test-widget test-e2e test-ts test-rust test-integration test-all coverage coverage-ts coverage-rust coverage-all clean preview preview-screenshot preview-video preview-clean lint lint-python lint-rust lint-fix lint-rust-fix setup-local setup-local-python setup-local-vscode setup-local-doctor setup-local-clean

# Local install for manual / extension testing
setup-local:
	scripts/setup-local.sh all

setup-local-python:
	scripts/setup-local.sh python

setup-local-vscode:
	scripts/setup-local.sh vscode

setup-local-doctor:
	scripts/setup-local.sh doctor

setup-local-clean:
	scripts/setup-local.sh clean

# Build frontend assets (WASM + TypeScript)
build-frontend:
	npm run build

# Build wheel (frontend + Rust extension)
build: build-frontend
	maturin build --release

# Development install (editable)
dev:
	npm run build
	maturin develop --release

# Production install
install: build-frontend
	pip install .

# Run Python tests
test:
	python -m pytest

# Run widget Python tests only
test-widget:
	python -m pytest tests/python/test_widget.py -v

# Run E2E browser test (3-layer Playwright suite, all active projects)
test-e2e:
	npx playwright test --project=webapp --project=contract --project=widget-jupyterlab --project=jupyterlab-doc

# Run TypeScript unit + component tests
test-ts:
	npm test

# Run Rust unit tests
test-rust:
	cargo test -p megane-core

# Run notebook tests (headless, no browser needed)
test-notebooks:
	python -m pytest tests/python/test_notebooks.py -v

# Run notebook E2E screenshot tests (requires Playwright + JupyterLab)
test-e2e-notebooks:
	node tests/e2e/test_notebook_screenshots.mjs

# Run integration tests (pip install smoke tests + demo code verification)
test-integration:
	python -m pytest tests/python/test_serve_integration.py tests/python/test_demo_code.py -v

# Run all tests (Python + TypeScript + Rust + E2E + Notebooks + Integration)
test-all: test test-ts test-rust test-e2e test-notebooks test-integration

# Run TypeScript tests with coverage
coverage-ts:
	npx vitest run --coverage

# Run Python tests with coverage
coverage:
	python -m pytest --cov=megane --cov-report=term-missing --cov-report=html:coverage/python

# Run Rust tests with coverage (requires cargo-tarpaulin)
coverage-rust:
	cargo tarpaulin -p megane-core --out Html --output-dir coverage/rust

# Run all coverage reports
coverage-all: coverage coverage-ts coverage-rust
	@echo ""
	@echo "Coverage reports generated:"
	@echo "  Python:     coverage/python/index.html"
	@echo "  TypeScript: coverage/ts/index.html"
	@echo "  Rust:       coverage/rust/tarpaulin-report.html"

# Dev preview: capture screenshots + video for mobile dev review
preview:
	node scripts/dev-preview.mjs --interact

# Dev preview: screenshots only
preview-screenshot:
	node scripts/dev-preview.mjs --screenshot

# Dev preview: video only
preview-video:
	node scripts/dev-preview.mjs --video --interact

# Dev preview: clean previous captures
preview-clean:
	rm -rf dev-preview/

# Lint Python code (ruff + ty)
lint-python:
	ruff check python/
	ruff format --check python/
	ty check python/

# Lint Rust code (clippy + fmt)
lint-rust:
	cargo fmt --all -- --check
	cargo clippy --all-targets -- -D warnings

# Lint all languages
lint: lint-python lint-rust

# Auto-fix Python lint issues
lint-fix:
	ruff check --fix python/
	ruff format python/

# Auto-fix Rust lint issues
lint-rust-fix:
	cargo fmt --all
	cargo clippy --fix --allow-dirty --allow-staged

# Clean build artifacts
clean:
	cargo clean
	rm -rf python/megane/static/app python/megane/static/widget.js python/megane/static/builder_widget.js python/megane/static/megane-rdkit.wasm
	rm -rf dist/ *.egg-info/ target/
