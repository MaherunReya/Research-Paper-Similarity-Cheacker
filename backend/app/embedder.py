"""SPECTER2 embedder, shared by the index builder and the API."""
import numpy as np
import torch
from adapters import AutoAdapterModel
from transformers import AutoTokenizer


class Embedder:
    def __init__(self, device: str | None = None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.tokenizer = AutoTokenizer.from_pretrained("allenai/specter2_base")
        self.model = AutoAdapterModel.from_pretrained("allenai/specter2_base")
        # "proximity" adapter = the one meant for similarity / nearest-neighbour search
        self.model.load_adapter(
            "allenai/specter2", source="hf", load_as="proximity", set_active=True
        )
        self.model.to(self.device).eval()

    @torch.inference_mode()
    def embed(self, papers: list[dict], batch_size: int = 32) -> np.ndarray:
        """papers: [{"title": str, "abstract": str}, ...] -> (n, 768) L2-normalised float32."""
        sep = self.tokenizer.sep_token
        texts = [f"{p.get('title') or ''}{sep}{p.get('abstract') or ''}" for p in papers]
        out = []
        for i in range(0, len(texts), batch_size):
            batch = self.tokenizer(
                texts[i : i + batch_size],
                padding=True,
                truncation=True,
                max_length=512,
                return_tensors="pt",
            ).to(self.device)
            vec = self.model(**batch).last_hidden_state[:, 0, :]  # [CLS] token
            vec = torch.nn.functional.normalize(vec, dim=-1)
            out.append(vec.cpu().numpy())
        return np.concatenate(out).astype("float32")
