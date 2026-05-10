# Current Wiki Update Set

These files are replacement pages for the GitHub wiki clone at:

```text
/home/tobayashi/Projekte/lokalwiki/Shipyard.wiki
```

Apply them from the main project root:

```bash
cp docs/wiki-drafts/current-wiki/Installation.md /home/tobayashi/Projekte/lokalwiki/Shipyard.wiki/Installation.md
cp docs/wiki-drafts/current-wiki/Configuration.md /home/tobayashi/Projekte/lokalwiki/Shipyard.wiki/Configuration.md
cp docs/wiki-drafts/current-wiki/Architecture.md /home/tobayashi/Projekte/lokalwiki/Shipyard.wiki/Architecture.md
cp docs/wiki-drafts/current-wiki/Plugin-System.md /home/tobayashi/Projekte/lokalwiki/Shipyard.wiki/Plugin-System.md

cd /home/tobayashi/Projekte/lokalwiki/Shipyard.wiki
git diff
git add Installation.md Configuration.md Architecture.md Plugin-System.md
git commit -m "docs: update install configuration architecture and plugins"
git push
```

