import { useEffect, useState } from 'react';
import { train, type Example, type TrainedModel } from '../../shared/ml/train';
import {
  fetchModels,
  fetchReadiness,
  fetchTrainingData,
  harvestLabels,
  promoteModel,
  registerModel,
  retireModelApi,
  sealModel,
  uploadModelFeatures,
  fetchHarvestDiagnostics,
  type HarvestDiagnostics,
  type ModelRow,
  type TrainingReadiness,
} from './api';

/**
 * Training a merchant-code model, here, in this tab.
 *
 * Not a command-line step and not a server job. Two reasons, and the second is
 * the one that decided it.
 *
 * The practical one: a personal model on a personal ledger should not need
 * Python installed, a virtualenv, or a token pasted into a shell. A button is
 * the difference between a feature that exists and a feature that gets used.
 *
 * The real one: training needs the whole corpus at once, and a Cloudflare
 * Worker request gets ten milliseconds of CPU. The browser has no such limit,
 * already holds an authenticated session, and is the one machine that is
 * unambiguously the owner's. The spending never leaves it — what gets uploaded
 * is the model, which is a few thousand n-gram weights and cannot be read back
 * into the descriptors it came from.
 *
 * What this screen will not do is hide the numbers. Training ends with an
 * out-of-fold score, and deploying is a separate press that can be refused.
 */

type Phase = 'idle' | 'loading' | 'training' | 'trained' | 'uploading' | 'done';

const pct = (n: unknown) => (typeof n === 'number' ? `${Math.round(n * 100)}%` : '—');

/**
 * The first thing that goes wrong after a deploy, every time.
 *
 * The model's tables arrive with the code but not with the database, and the
 * raw SQL error that follows says "no such table" — which reads like a bug
 * rather than a step nobody has taken yet.
 */
function explain(e: unknown): string {
  const m = (e as Error).message ?? String(e);
  if (/no such table|no such column|has no column/i.test(m)) {
    return `The database is behind the code — press “Bring the database up to date” in Maintenance below, then try again. (${m})`;
  }
  return m;
}

export default function ModelTrainer() {
  const [readiness, setReadiness] = useState<TrainingReadiness | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<{ done: number; total: number; note: string } | null>(null);
  const [model, setModel] = useState<TrainedModel | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [diag, setDiag] = useState<HarvestDiagnostics | null>(null);

  function refresh() {
    fetchReadiness().then(setReadiness).catch(() => {});
    fetchHarvestDiagnostics()
      .then((d) => setDiag(d.diagnostics))
      .catch(() => {});
    fetchModels()
      .then((d) => setModels(d.models))
      .catch(() => {});
  }
  useEffect(refresh, []);

  async function harvest() {
    setErr(null);
    setMsg(null);
    try {
      const r = await harvestLabels();
      setReadiness(r.readiness);
      setDiag(r.diagnostics);
      setMsg(
        `${r.scanned} coded transaction${r.scanned === 1 ? '' : 's'} read · ${r.added} new label${r.added === 1 ? '' : 's'}.`
      );
    } catch (e) {
      setErr(explain(e));
    }
  }

  async function runTraining() {
    setErr(null);
    setMsg(null);
    setModel(null);
    setPhase('loading');
    try {
      const data = await fetchTrainingData();
      const examples: Example[] = data.examples
        .filter((e) => e.normalized_descriptor && e.confirmed_mcc)
        .map((e) => ({ text: e.normalized_descriptor, label: e.confirmed_mcc! }));

      if (examples.length < 50) {
        setPhase('idle');
        setErr(
          `Only ${examples.length} usable label${examples.length === 1 ? '' : 's'}. There is nothing here a model could learn from yet.`
        );
        return;
      }

      setPhase('training');
      // Yield first, so the button's "training" state actually paints before
      // the main thread is taken for several seconds.
      await new Promise((r) => setTimeout(r, 30));

      const result = train(examples, {
        onProgress: (done, total, note) => setProgress({ done, total, note }),
      });

      if ('error' in result) {
        setPhase('idle');
        setErr(result.error);
        return;
      }
      setModel(result);
      setPhase('trained');
    } catch (e) {
      setPhase('idle');
      setErr(explain(e));
    } finally {
      setProgress(null);
    }
  }

  async function deploy(force: boolean) {
    if (!model) return;
    setErr(null);
    setMsg(null);
    setPhase('uploading');
    try {
      const reg = await registerModel({
        model_key: 'merchant_mcc',
        architecture: model.architecture,
        training_examples: model.metrics.training_examples,
        validation_metrics: model.metrics as unknown as Record<string, unknown>,
        classes: model.classes,
        intercept: model.intercept,
        high_confidence: model.high_confidence,
        note: `trained in the browser on ${model.metrics.training_examples} labels`,
      });
      if (!reg.ok || !reg.version) throw new Error(reg.error ?? 'could not register the model');

      // Uploaded in slices: a whole model is more than one request should
      // carry, and a slice that fails can be retried without redoing the rest.
      const SLICE = 2000;
      for (let i = 0; i < model.features.length; i += SLICE) {
        setProgress({
          done: i,
          total: model.features.length,
          note: `uploading ${i.toLocaleString()} of ${model.features.length.toLocaleString()} features`,
        });
        const r = await uploadModelFeatures({
          model_key: 'merchant_mcc',
          version: reg.version,
          features: model.features.slice(i, i + SLICE),
        });
        if (!r.ok) throw new Error(r.error ?? 'a slice of the model failed to upload');
      }
      setProgress(null);

      const sealed = await sealModel({ model_key: 'merchant_mcc', version: reg.version });
      if (sealed.feature_count !== model.features.length) {
        throw new Error(
          `only ${sealed.feature_count} of ${model.features.length} features arrived — the model was not deployed`
        );
      }

      const promoted = await promoteModel({ model_key: 'merchant_mcc', version: reg.version, force });
      if (!promoted.ok) {
        setPhase('trained');
        setErr(
          `Saved as version ${reg.version}, but not made live: ${promoted.missing?.join('; ') ?? promoted.error}.`
        );
        refresh();
        return;
      }

      setPhase('done');
      setMsg(
        `Version ${reg.version} is live${promoted.retired ? `, replacing version ${promoted.retired}` : ''}. ` +
          `It will be consulted only where no evidence exists, and only above ${pct(model.high_confidence)} confidence.`
      );
      refresh();
    } catch (e) {
      setPhase('trained');
      setErr(explain(e));
    } finally {
      setProgress(null);
    }
  }

  async function retire(m: ModelRow) {
    try {
      await retireModelApi({ model_key: m.model_key, version: m.version });
      setMsg(`Version ${m.version} retired. Codes go back to being read from evidence alone.`);
      refresh();
    } catch (e) {
      setErr(explain(e));
    }
  }

  const active = models?.find((m) => m.status === 'active');
  const busy = phase === 'loading' || phase === 'training' || phase === 'uploading';

  return (
    <section className="card">
      <header>
        <div>
          <h2>Train a code detector</h2>
          <p className="sub">
            A model that reads a statement line and guesses its merchant code, learned from the codes your own banks
            have already put on your transactions. Training runs here, in this tab — your spending is not sent
            anywhere.
          </p>
        </div>
      </header>

      {active ? (
        <p className="sub">
          Live: <strong>version {active.version}</strong>, trained on {active.training_examples.toLocaleString()}{' '}
          labels across {active.feature_count.toLocaleString()} fragments · high-confidence precision{' '}
          {pct(active.validation_metrics?.high_confidence_precision)} · deployed {active.deployed_at}.{' '}
          <button className="link" onClick={() => retire(active)}>
            Retire it
          </button>
        </p>
      ) : (
        <p className="sub">
          No model is live. Codes are read from evidence alone, and unknown merchants go to Review.
        </p>
      )}

      {/*
        Why the number is what it is. A harvest that reports a count and
        nothing else leaves four quite different situations looking identical,
        and zero is the one that most needs explaining.
      */}
      {diag && (
        <>
          <p className="sub">{diag.reading}</p>
          <ul className="stmt-summary">
            <li>
              transactions <span className="mono">{diag.transactions.toLocaleString()}</span>
            </li>
            <li>
              carrying a code <span className="mono">{diag.transactions_with_mcc.toLocaleString()}</span>
            </li>
            <li>
              usable as labels <span className="mono">{diag.bank_supplied_candidates.toLocaleString()}</span>
            </li>
            <li>
              distinct codes <span className="mono">{diag.distinct_codes_available}</span>
            </li>
            <li>
              distinct lines <span className="mono">{diag.distinct_descriptors_available}</span>
            </li>
          </ul>
        </>
      )}

      {readiness && (
        <ul className="stmt-summary">
          <li>
            labels <span className="mono">{readiness.labels.toLocaleString()}</span> / {readiness.thresholds.min_labels}
          </li>
          <li>
            distinct lines <span className="mono">{readiness.distinct_merchants}</span> /{' '}
            {readiness.thresholds.min_merchants}
          </li>
          <li>
            codes with {readiness.thresholds.min_per_category}+ <span className="mono">{readiness.categories_meeting_bar}</span> /{' '}
            {readiness.thresholds.min_categories}
          </li>
        </ul>
      )}

      <div className="entry-foot">
        <button className="secondary" onClick={harvest} disabled={busy}>
          Read codes from my ledger
        </button>
        <button onClick={runTraining} disabled={busy || !readiness?.ready}>
          {phase === 'training' ? 'Training…' : phase === 'loading' ? 'Loading…' : 'Train a model'}
        </button>
        {msg && <span className="ok-text">{msg}</span>}
        {err && <span className="err-text">{err}</span>}
      </div>

      {readiness && !readiness.ready && (
        <p className="sub dim">
          Not enough yet — {readiness.blocking.join(', ')}. Importing statements that carry codes is the fastest way
          to move this; answering reviews is the other.
        </p>
      )}

      {progress && (
        <p className="sub">
          {progress.note}
          {progress.total > 0 && <> · {Math.round((progress.done / progress.total) * 100)}%</>}
        </p>
      )}

      {model && (
        <>
          <h3>What it scored</h3>
          <p className="sub">
            Measured on descriptors held out of training, four ways, with the vocabulary rebuilt each time — so these
            are not the model marking its own work.
          </p>
          <ul className="stmt-summary">
            <li>
              high-confidence precision <span className="mono">{pct(model.metrics.high_confidence_precision)}</span>
            </li>
            <li>
              says so this often <span className="mono">{pct(model.metrics.high_confidence_share)}</span>
            </li>
            <li>
              macro F1 <span className="mono">{model.metrics.macro_f1}</span>
            </li>
            <li>
              accuracy <span className="mono">{pct(model.metrics.accuracy)}</span>
            </li>
            <li>
              codes it can name <span className="mono">{model.metrics.classes}</span>
            </li>
          </ul>
          {model.metrics.excluded_classes.length > 0 && (
            <p className="sub dim">
              {model.metrics.excluded_classes.length} code(s) were left out for having fewer than{' '}
              {model.options.min_per_class} examples ({model.metrics.excluded_examples} transactions). The model will
              never name those — those merchants keep going to Review, which is the right outcome.
            </p>
          )}

          <details className="trail">
            <summary>Per code ({model.metrics.per_class.length})</summary>
            <ul className="notes">
              {model.metrics.per_class
                .slice()
                .sort((a, b) => b.support - a.support)
                .map((c) => (
                  <li key={c.label}>
                    <strong>{c.label}</strong> · {c.support} examples
                    <div className="sub">
                      precision {c.precision} · recall {c.recall} · F1 {c.f1}
                    </div>
                  </li>
                ))}
            </ul>
          </details>

          <div className="entry-foot">
            <button onClick={() => deploy(false)} disabled={busy}>
              {phase === 'uploading' ? 'Deploying…' : 'Use this model'}
            </button>
            <button className="secondary" onClick={() => deploy(true)} disabled={busy}>
              Use it anyway
            </button>
          </div>
          <p className="sub dim">
            “Use this model” refuses if it did not clear the bar — at least {model.metrics.training_examples >= 300 ? '' : '300 labels, '}
            90% precision on the answers it calls confident. “Use it anyway” overrides that, and records that it was
            overridden.
          </p>
        </>
      )}

      {models && models.length > 0 && (
        <details className="trail">
          <summary>All versions ({models.length})</summary>
          <ul className="notes">
            {models.map((m) => (
              <li key={m.id}>
                <strong>v{m.version}</strong> · {m.status} · {m.training_examples.toLocaleString()} labels ·{' '}
                {pct(m.validation_metrics?.high_confidence_precision)} precision
                {m.note && <div className="sub">{m.note}</div>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
