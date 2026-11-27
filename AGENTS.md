# Repository instructions

The project has not launched and does not require backward compatibility. When changing a database schema, update the initial schema directly. Do not add migrations, upgrade paths, or compatibility layers. Replace obsolete API contracts and remove their unused code. Validate schema changes against a fresh database.
