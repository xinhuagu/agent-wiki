# NIST CCVS — REPLACING subset

Curated slice of the NIST COBOL85 Compiler Validation System
(`newcob.val`, public-domain, distributed via the GnuCOBOL project at
[sourceforge.net/projects/gnucobol/files/nist](https://sourceforge.net/projects/gnucobol/files/nist/)).
Used as the dogfood corpus for the lineage baseline regression test
in `dogfood-ccvs.test.ts` (the per-fixture eval-harness tests live in
`field-lineage-eval.test.ts` — different surface).

Contents:

- All **SM** ("Source Manipulation") test programs from the CCVS — these
  exercise `COPY` / `REPLACING` semantics, which is the only family
  the dogfood test grades.
- All **K**-prefixed copybooks (`*.cpy`) from the CCVS — included
  permissively so every COPY directive in the SM programs resolves.

Not included:

- Programs from other CCVS test groups (CM, DB, NC, IF, etc.) — their
  emission would dilute the dogfood signal without exercising the
  candidate-sourcing paths the regression test cares about.

The expected dogfood output is committed at
`baseline-inferred-high.txt` next to this file. If you intentionally
change candidate-sourcing semantics in `field-lineage.ts`, regenerate
the baseline:

```bash
npx tsx scripts/dogfood-lineage.ts \
  src/cobol/__tests__/corpora/ccvs-replacing-subset \
  src/cobol/__tests__/corpora/ccvs-replacing-subset/baseline-inferred-high.txt
```

Review the diff before committing — every change to the baseline is a
behavior change in the lineage builder.
