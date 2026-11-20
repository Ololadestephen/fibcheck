# Sample check

A real fibcheck check, saved on November 16, 2026, for trying the report without any keys:

```sh
npm ci && npm run build
node dist/cli.js report examples/sample-check/check.json
```

It writes `report.html` and `badge.svg` here. The check tested Linkding's docs, `admin.md` line 14 at commit `27b7303`: "To open the Admin app, go the *Settings* view and click on the *Admin* tab." Kane failed it in two separate runs, a control with the same account passed, and a person read the screenshots before it was called outdated. Only the step screenshots are included. Local paths, Kane session folders and links to the private Kane dashboard were removed; nothing else was changed.
