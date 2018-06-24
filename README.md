semigrate
=========

*semigrate* is a tool to run [semantically versioned](http://semver.org/) migration scripts
on a PostgreSQL database.

## Usage
`semigrate [options] [version]`

## Migration scripts

```
migrations/
├── 0.0.1-initial-schema/
│   ├── 0001-tables.sql
│   ├── 0002-views.sql
│   └── 0003-functions.sql
├── 0.0.2-add-views.sql
└── 1.0.0-production.sql
```
