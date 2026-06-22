/**
 * ats-match.ts — ATS keyword-match scoring (Jobscan-style).
 *
 * Real ATS / recruiter-screen tools rank a resume by how many of a job's hard-skill keywords it
 * contains. This scores a resume's TEXT against a job's JD: it extracts the skill keywords the JD
 * actually mentions (from a curated ML/AI-platform lexicon + the title), then measures coverage in
 * the resume and reports the matched + missing terms (the missing ones are the gaps to add).
 *
 * This is distinct from scoring/score.ts (which gates on profile fit). ats-match answers: "if this
 * resume goes through an ATS for this job, how well does it keyword-match?"
 */

import type { JobRow } from "../types.js";

/** A skill term + its aliases. Short/ambiguous tokens are matched on word boundaries. */
interface Term {
  canonical: string;
  aliases?: string[];
}

/** Curated ML/AI-platform hard-skill lexicon. Coverage of these is what ATS keyword screens reward. */
const LEXICON: Term[] = [
  // languages
  { canonical: "python" }, { canonical: "sql" }, { canonical: "typescript", aliases: ["javascript"] },
  { canonical: "java" }, { canonical: "scala" }, { canonical: "golang", aliases: ["go "] }, { canonical: "c++" }, { canonical: "bash", aliases: ["shell scripting"] },
  // ml frameworks
  { canonical: "pytorch" }, { canonical: "tensorflow" }, { canonical: "scikit-learn", aliases: ["sklearn"] },
  { canonical: "xgboost" }, { canonical: "keras" }, { canonical: "jax" }, { canonical: "hugging face", aliases: ["huggingface", "transformers"] },
  // distributed / training
  { canonical: "kubernetes", aliases: ["k8s"] }, { canonical: "eks" }, { canonical: "aks" }, { canonical: "gke" },
  { canonical: "ray" }, { canonical: "deepspeed" }, { canonical: "horovod" }, { canonical: "megatron" },
  { canonical: "spark", aliases: ["pyspark"] }, { canonical: "flink" }, { canonical: "dask" }, { canonical: "slurm" },
  { canonical: "mixed precision" }, { canonical: "gpu", aliases: ["gpus"] }, { canonical: "cuda" }, { canonical: "distributed training" },
  // serving / inference
  { canonical: "triton" }, { canonical: "vllm" }, { canonical: "tensorrt" }, { canonical: "kserve" }, { canonical: "seldon" },
  { canonical: "bentoml" }, { canonical: "torchserve" }, { canonical: "ray serve" },
  { canonical: "model serving", aliases: ["model deployment"] }, { canonical: "batch inference" },
  { canonical: "real-time inference", aliases: ["online inference", "low latency inference"] }, { canonical: "inference" },
  // mlops
  { canonical: "mlops" }, { canonical: "mlflow" }, { canonical: "kubeflow" }, { canonical: "metaflow" },
  { canonical: "airflow" }, { canonical: "argo", aliases: ["argo cd", "argo workflows"] }, { canonical: "dagster" }, { canonical: "prefect" },
  { canonical: "dvc" }, { canonical: "ci/cd", aliases: ["cicd", "continuous integration"] }, { canonical: "continuous training" },
  { canonical: "model registry" }, { canonical: "feature store", aliases: ["feast", "tecton", "featureform"] },
  { canonical: "experiment tracking" }, { canonical: "lineage" }, { canonical: "reproducibility" }, { canonical: "model governance", aliases: ["governance"] },
  { canonical: "champion/challenger", aliases: ["champion challenger"] }, { canonical: "canary" }, { canonical: "shadow deployment" }, { canonical: "a/b testing", aliases: ["ab testing"] },
  // llm / genai
  { canonical: "llm", aliases: ["large language model", "large language models"] }, { canonical: "genai", aliases: ["generative ai"] },
  { canonical: "rag", aliases: ["retrieval augmented generation", "retrieval-augmented"] }, { canonical: "langchain" }, { canonical: "langgraph" },
  { canonical: "llamaindex" }, { canonical: "bedrock" }, { canonical: "azure openai" }, { canonical: "openai" }, { canonical: "vertex ai" },
  { canonical: "vector database", aliases: ["vector db", "pinecone", "weaviate", "opensearch", "faiss", "milvus", "qdrant", "chroma"] },
  { canonical: "embeddings" }, { canonical: "fine-tuning", aliases: ["finetuning", "fine tuning", "lora", "peft"] },
  { canonical: "prompt engineering", aliases: ["prompting"] }, { canonical: "agent", aliases: ["agents", "agentic"] }, { canonical: "multi-agent", aliases: ["multi agent"] },
  { canonical: "mcp", aliases: ["model context protocol"] }, { canonical: "guardrails" }, { canonical: "llm-as-judge", aliases: ["llm as judge"] },
  { canonical: "langsmith" }, { canonical: "langfuse" }, { canonical: "evaluation", aliases: ["evals", "eval framework"] }, { canonical: "llmops" },
  // cloud / data infra
  { canonical: "aws" }, { canonical: "azure" }, { canonical: "gcp", aliases: ["google cloud"] },
  { canonical: "sagemaker" }, { canonical: "lambda" }, { canonical: "databricks" }, { canonical: "snowflake" },
  { canonical: "bigquery" }, { canonical: "redshift" }, { canonical: "kinesis" }, { canonical: "kafka" }, { canonical: "event hubs" },
  { canonical: "delta lake" }, { canonical: "unity catalog" }, { canonical: "glue" }, { canonical: "emr" },
  // devops / observability
  { canonical: "docker", aliases: ["containers", "containerization"] }, { canonical: "terraform" }, { canonical: "bicep" }, { canonical: "cloudformation" },
  { canonical: "helm" }, { canonical: "github actions" }, { canonical: "jenkins" }, { canonical: "gitops" },
  { canonical: "prometheus" }, { canonical: "grafana" }, { canonical: "datadog" }, { canonical: "opentelemetry", aliases: ["otel"] },
  { canonical: "observability" }, { canonical: "slo", aliases: ["slos", "sli"] }, { canonical: "monitoring" }, { canonical: "drift", aliases: ["data drift", "model drift", "concept drift"] },
  // data
  { canonical: "etl", aliases: ["elt"] }, { canonical: "data pipeline", aliases: ["data pipelines"] }, { canonical: "feature engineering" },
  { canonical: "postgresql", aliases: ["postgres"] }, { canonical: "dynamodb" }, { canonical: "redis" }, { canonical: "mongodb" },
  // domains
  { canonical: "computer vision", aliases: ["cv "] }, { canonical: "nlp", aliases: ["natural language processing"] },
  { canonical: "recommendation", aliases: ["recommender", "recsys"] }, { canonical: "ranking" }, { canonical: "search" }, { canonical: "forecasting" }, { canonical: "personalization" },
  // api
  { canonical: "fastapi" }, { canonical: "grpc" }, { canonical: "rest api", aliases: ["restful"] }, { canonical: "graphql" }, { canonical: "react" },
];

const TITLE_STOPWORDS = new Set([
  "senior", "staff", "lead", "principal", "engineer", "engineering", "ii", "iii", "iv", "sr", "jr",
  "the", "a", "an", "of", "and", "or", "for", "to", "in", "on", "with", "at", "team", "i", "remote",
  "us", "usa", "manager", "specialist", "developer", "iv", "level",
]);

/** Build a matcher: short/alnum tokens use word boundaries; multiword/symbolic use substring. */
function makeMatcher(term: Term): (text: string) => boolean {
  const variants = [term.canonical, ...(term.aliases ?? [])].map((s) => s.toLowerCase());
  const tests = variants.map((v) => {
    const hasSymbol = /[^a-z0-9 ]/.test(v); // c++, ci/cd, a/b, scikit-learn
    if (v.includes(" ") || hasSymbol || v.length > 5) {
      return (text: string) => text.includes(v);
    }
    const re = new RegExp(`(^|[^a-z0-9])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
    return (text: string) => re.test(text);
  });
  return (text: string) => tests.some((t) => t(text));
}

const MATCHERS = LEXICON.map((t) => ({ label: t.canonical, match: makeMatcher(t) }));

export interface AtsMatchResult {
  jobId: number;
  company: string;
  title: string;
  url: string;
  remote: boolean | null;
  score: number; // 0-100 overall ATS match
  keywordScore: number; // % of JD skill-keywords present in resume
  titleScore: number; // % of meaningful title tokens present in resume
  jdKeywordCount: number;
  matched: string[];
  missing: string[]; // JD skills absent from resume → the gaps to add
}

/** Score one resume against one job. */
export function atsMatch(resumeText: string, job: JobRow): AtsMatchResult {
  const resume = resumeText.toLowerCase();
  const jd = `${job.title}\n${job.jdText}`.toLowerCase();

  // JD keywords = lexicon terms the JD actually mentions.
  const jdTerms = MATCHERS.filter((m) => m.match(jd));
  const matched: string[] = [];
  const missing: string[] = [];
  for (const term of jdTerms) {
    (term.match(resume) ? matched : missing).push(term.label);
  }
  const keywordScore = jdTerms.length ? (matched.length / jdTerms.length) * 100 : 0;

  // Title tokens (minus stopwords) present in the resume.
  const titleTokens = [...new Set(job.title.toLowerCase().replace(/[^a-z0-9+/ ]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !TITLE_STOPWORDS.has(w)))];
  const titleHits = titleTokens.filter((w) => resume.includes(w));
  const titleScore = titleTokens.length ? (titleHits.length / titleTokens.length) * 100 : 100;

  const score = Math.round(0.75 * keywordScore + 0.25 * titleScore);
  return {
    jobId: job.id,
    company: job.company,
    title: job.title,
    url: job.url,
    remote: job.remote,
    score,
    keywordScore: Math.round(keywordScore),
    titleScore: Math.round(titleScore),
    jdKeywordCount: jdTerms.length,
    matched,
    missing,
  };
}

/** Score a resume against many jobs, ranked best-first. */
export function atsMatchMany(resumeText: string, jobs: JobRow[]): AtsMatchResult[] {
  return jobs.map((j) => atsMatch(resumeText, j)).sort((a, b) => b.score - a.score);
}
