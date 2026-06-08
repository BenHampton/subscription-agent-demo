// PURPOSE: Wraps the Voyage AI embedding API
//
// the modules converts text into vector embeddings
//
// PATTER: Simple Client Wrapper
// We wrap the raw HTTP API rather than using the third-party SDK because:
// A - Voyage AI's API is a single endpoint
// B - wrapping it ourselves means zero extra dependencies and full control over error handling, retries, and typing

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = process.env.VOYAGE_MODEL || 'voyage-3-lite';

interface VoyageEmbeddingRequest {
  input: string[];
  model: string;
  input_type: 'document' | 'query';
}

interface VoyageEmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  modal: string;
  index: number;
  usage: {
    total_tokens: number;
  };
}

export const embedTexts = async (
  texts: string[],
  inputType: 'document' | 'query',
): Promise<number[][]> => {
  // Validate input — catch empty arrays before hitting the API
  if (texts.length === 0) {
    return [];
  }

  // Batch into groups of 128 (Voyage API limit per request)
  const BATCH_SIZE = 128;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: batch,
        model: VOYAGE_MODEL,
        input_type: inputType,
      } satisfies VoyageEmbeddingRequest),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Voyage AI embedding failed (${response.status}): ${error}`,
      );
    }

    const data = (await response.json()) as VoyageEmbeddingResponse;

    // API may return embeddings out of order.
    // Sort by index to preserve input order.
    const sorted = data.data.sort((a, b) => a.index - b.index);
    allEmbeddings.push(...sorted.map((d) => d.embedding));
  }

  return allEmbeddings;
};

export const embedQuery = async (text: string): Promise<number[]> => {
  const [embedding] = await embedTexts([text], 'query');
  return embedding;
};
