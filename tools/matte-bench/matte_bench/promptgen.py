"""LLM-imagined subjects: a small model invents what to matte next.

The template banks give variety within fixed patterns; a Haiku-class model
gives open-ended variety, steered by per-bucket hints at the exact
transparency difficulty the bucket exists to probe. The model only writes the
subject DESCRIPTION — composition (production boilerplate), seed, size and
registration stay with the bench, and the output must pass the same isolation
rules the templates are tested against. Anything invalid, or any provider
error, returns None and the caller falls back to the template sampler — the
bench never depends on the LLM being up.
"""
import os
import random

from matte_bench.corpus import Subject
from matte_bench.sampler import compose_prompt

PROMPT_MODEL = os.environ.get("MATTE_BENCH_PROMPT_MODEL",
                              "anthropic/claude-haiku-4.5")

# What each bucket is probing for — fed to the model so invented subjects
# carry the right kind of difficulty, not just novelty.
BUCKET_HINTS = {
    "wispy": ("fine semi-transparent fringes: hair-thin filaments, feathery "
              "or downy edges, floating strands that partial alpha must keep"),
    "filigree": ("very thin rigid structures: hairline metal curls, pierced "
                 "lattice, delicate strokes that an eroding mask would break"),
    "enclosed-holes": ("interior negative space: holes, empty bays, windows "
                       "or gaps fully enclosed by the subject that the matte "
                       "must punch completely clear"),
    "glow-soft": ("soft luminous transparency: glow, bloom, smoke, glass or "
                  "haze where PARTIAL alpha is the correct answer"),
    "crisp-text": ("hard-edged lettering: a short game logo wordmark with "
                   "sharp serifs and thin strokes where halo or erosion is "
                   "glaring"),
    "low-contrast": ("a subject whose tone is nearly identical to the plain "
                     "ground it is cut out on: minimal tonal separation"),
}

_BANNED = ("background", "backdrop", "scene", "in front of", "behind")


def request_text(bucket: str, recent: list[str] | tuple = ()) -> str:
    avoid = ""
    if recent:
        avoid = ("\n- Be inventive; do NOT repeat or closely resemble these "
                 "recent subjects: " + "; ".join(recent))
    return (
        "You invent ONE test subject for a transparency-masking benchmark "
        "for premium slot-game art.\n"
        f"Difficulty to probe: {BUCKET_HINTS[bucket]}.\n"
        "Rules:\n"
        "- Describe a single isolated subject only: no scene, no setting, "
        "nothing around it or obscuring it.\n"
        "- Describe only the object itself: no lighting, atmosphere or "
        "environment words (they make the image model paint a backdrop).\n"
        "- One line, roughly 6 to 18 words, no quotes, no trailing "
        f"punctuation.{avoid}\n"
        "Reply with the description only."
    )


async def imagine_description(provider, model: str, bucket: str,
                              recent=()) -> str | None:
    chunks = []
    async for chunk in provider.stream(
            [{"role": "user", "content": request_text(bucket, list(recent))}],
            model):
        chunks.append(chunk)
    text = "".join(chunks).strip()
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    line = line.strip("\"'").rstrip(".").strip()
    low = line.lower()
    if not 3 <= len(line) <= 160:
        return None
    if any(banned in low for banned in _BANNED):
        return None
    if "{" in line or "}" in line:
        return None
    return line


async def sample_subject_llm(bucket: str, rng: random.Random, templates: dict,
                             provider, model: str,
                             recent=()) -> Subject | None:
    """A Subject invented by the LLM, or None (invalid output / provider
    error) — the caller falls back to the template sampler."""
    try:
        description = await imagine_description(provider, model, bucket, recent)
    except Exception as exc:                      # noqa: BLE001 - reported, not swallowed
        print(f"prompt-LLM failed ({model}): {exc}")
        return None
    if description is None:
        return None
    spec = templates[bucket]
    role = "logo" if bucket == "crisp-text" else "misc"
    prompt = compose_prompt(description, role, bucket)
    seed = rng.randrange(1, 2**31)
    return Subject(id=f"{bucket}-{seed}", bucket=bucket, prompt=prompt,
                   seed=seed, width=spec["width"], height=spec["height"])
