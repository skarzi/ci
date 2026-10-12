SHELL := /usr/bin/env bash

# Dynamically extract Makefile stages from .PHONY declarations.
_MAKEFILE_TARGETS := $(shell grep -h '^.PHONY:' $(firstword $(MAKEFILE_LIST)) | sed 's/^.PHONY: //' | tr ' ' '\n' | sort -u)
EXTRA_ARGS = $(filter-out $(_MAKEFILE_TARGETS),$(MAKECMDGOALS))

.DEFAULT_GOAL := help

# NOTE: `make <target> -- arg ...` makes args (files, `act` events) extra goals.
# Without a rule make prints noise or fails for them. No-op for them, but a
# mistyped first goal still errors.
.PHONY: FORCE
FORCE:
%: FORCE
	@test '$@' != '$(firstword $(MAKECMDGOALS))' \
		|| { echo "make: *** No rule to make target '$@'." >&2; exit 1; }

#: Install all mise dependencies.
.PHONY: install-mise
install-mise:
	@mise trust
	@mise install

#: Install pre-commit dependency and hook.
.PHONY: install-pre-commit
install-pre-commit:
	@uv tool install pre-commit
	@uv tool run pre-commit install --install-hooks

#: Install Python dependencies.
.PHONY: install-python
install-python:
	@uv sync --locked --dev

#: Install Node dependencies.
.PHONY: install-node
install-node:
	@npm install

#: Install all dependencies.
.PHONY: install
install: \
	install-mise \
	install-pre-commit \
	install-python \
	install-node

#: Lint the commit message.
.PHONY: lint-commit-message
lint-commit-message:
	@npm run lint:commit-message -- $(EXTRA_ARGS)

#: Lint the pre-commit config.
.PHONY: lint-pre-commit-hook-config
lint-pre-commit-hook-config:
	@uv tool run pre-commit validate-config .pre-commit-config.yaml

#: Lint GitHub Actions workflow and action files.
.PHONY: lint-github-actions
lint-github-actions:
	@actionlint $(EXTRA_ARGS)

#: Scan GitHub Actions for security flaws and fix them.
.PHONY: lint-fix-security
lint-fix-security:
	@zizmor --fix $(or $(EXTRA_ARGS),.)

#: Lint YAML files.
.PHONY: lint-yaml
lint-yaml:
	@uv run yamllint --format github $(or $(EXTRA_ARGS),.)

#: Lint Makefile syntax.
.PHONY: lint-makefile
lint-makefile:
	@checkmake $(or $(EXTRA_ARGS),Makefile)

#: Lint and fix Markdown files.
.PHONY: lint-fix-markdown
lint-fix-markdown:
	@npm run lint:md -- $(or $(EXTRA_ARGS),"**/*.md")

#: Lint and fix TOML files.
.PHONY: lint-fix-toml
lint-fix-toml:
	@uv run tombi format $(EXTRA_ARGS) && uv run tombi lint $(EXTRA_ARGS)

#: Format, lint and fix TypeScript files, then type check.
.PHONY: lint-fix-typescript
lint-fix-typescript:
	@npm run format:ts -- $(or $(EXTRA_ARGS),scripts/)
	@npm run lint:ts -- $(or $(EXTRA_ARGS),scripts/)
	@npm run lint:types

#: Lint and fix the whole project.
.PHONY: lint-fix
lint-fix: lint-makefile lint-pre-commit-hook-config lint-yaml \
	lint-github-actions lint-fix-security lint-fix-markdown lint-fix-toml \
	lint-fix-typescript

#: Run TypeScript tests.
.PHONY: test-typescript
test-typescript:
	@npm run test

#: Run all tests.
.PHONY: test
test: test-typescript

#: Run GitHub Actions workflow(s) locally using `act`.
.PHONY: act
act:
	@act $(or $(EXTRA_ARGS),pull_request)

# TODO(skarzi): Call this stage from a dedicated release workflow. Manual for
# now: `GITHUB_TOKEN` is refused for refs touching `.github/workflows/*`, so an
# App token or PAT is needed.
#: Tag and push release: `make release -- [major|minor|patch]` (default: patch).
.PHONY: release
release:
	@bun scripts/typescript/release.ts $(or $(EXTRA_ARGS),patch)

#: Clean project artifacts.
.PHONY: clean
clean:
	@rm -rf node_modules/ .venv/

#: Install, lint, and fix
.PHONY: all
all: install lint-fix test

#: Show available targets.
.PHONY: help
help:
	@awk '/^#: / { sub(/^#: /, ""); desc = desc ? desc " " $$0 : $$0; next } /^[a-zA-Z_-]+:/ && desc { sub(/:.*/, ""); printf "\033[36m%-28s\033[0m %s\n", $$0, desc; desc = "" }' $(MAKEFILE_LIST) | sort
