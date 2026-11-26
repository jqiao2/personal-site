"""Is this a photo of food? CLIP zero-shot, on the CPU, offline after the first run."""
import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer

REPO = "Xenova/clip-vit-base-patch32"

FOOD = [
    "a photo of a plate of food",
    "a photo of a restaurant meal on a table",
    "a photo of a bowl of noodles or soup",
    "a photo of a dessert, pastry or ice cream",
    "a photo of a sandwich, burger, pizza or tacos",
    "a photo of sushi or small dishes",
    "a photo of a takeout container with food",
    "a photo of a cocktail, coffee or drink in a glass or cup",
]
# Everything else in a phone's camera roll. The last few are the near misses.
OTHER = [
    "a photo of a person",
    "a selfie or group of people",
    "a photo of a landscape, mountains or the sky",
    "a photo of a city street or building",
    "a photo of a cat or dog",
    "a photo of a bicycle or a car",
    "a photo of a room or furniture",
    "a photo of clothes or shoes",
    "a screenshot of a phone or computer",
    "a photo of a document, receipt or sign",
    "a photo of a museum or artwork",
    "a photo of an electronic device or screen",
    "a photo of flowers or plants",
    "a photo of a concert, stage or sports event",
    "a photo of a train, plane or station",
    "a photo of water, beach or snow",
    "a photo of grocery store shelves",
    "a photo of packaged products or boxes",
    "a photo of an empty table",
    "a photo of a tool or household object",
]

MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)


def _unit(x):
    return x / np.linalg.norm(x, axis=-1, keepdims=True)


class Detector:
    def __init__(self, threads=4):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        load = lambda f: ort.InferenceSession(hf_hub_download(REPO, f), opts, providers=["CPUExecutionProvider"])
        tok = Tokenizer.from_file(hf_hub_download(REPO, "tokenizer.json"))
        tok.enable_padding(pad_id=49407, pad_token="<|endoftext|>")
        ids = np.array([e.ids for e in tok.encode_batch(FOOD + OTHER)], dtype=np.int64)
        text = load("onnx/text_model.onnx")
        self.text = _unit(text.run(["text_embeds"], {"input_ids": ids})[0])
        self.vision = load("onnx/vision_model.onnx")

    def score(self, img):
        """Probability (0-1) that a PIL image is food."""
        img = img.convert("RGB")
        w, h = img.size
        k = 224 / min(w, h)
        img = img.resize((max(224, round(w * k)), max(224, round(h * k))), 3)
        x, y = (img.width - 224) // 2, (img.height - 224) // 2
        a = np.asarray(img.crop((x, y, x + 224, y + 224)), dtype=np.float32) / 255
        pix = ((a - MEAN) / STD).transpose(2, 0, 1)[None]
        emb = _unit(self.vision.run(["image_embeds"], {"pixel_values": pix})[0])[0]
        logits = 100 * self.text @ emb
        p = np.exp(logits - logits.max())
        return float(p[: len(FOOD)].sum() / p.sum())
