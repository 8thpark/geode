.PHONY: create-dev-vault

create-dev-vault:
	mkdir -p dev-vault/.obsidian/plugins
	ln -sfn $(CURDIR) dev-vault/.obsidian/plugins/geode
