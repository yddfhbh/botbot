export function createTetrioPRNG(seed) {
  let state = Number.parseInt(seed, 10) % 2147483647;
  if (state <= 0) state += 2147483646;

  return {
    next() {
      state = (16807 * state) % 2147483647;
      return state;
    },

    nextFloat() {
      return (this.next() - 1) / 2147483646;
    },

    shuffleArray(items) {
      let index = items.length;
      while (--index) {
        const nextIndex = Math.floor(this.nextFloat() * (index + 1));
        [items[index], items[nextIndex]] = [items[nextIndex], items[index]];
      }
      return items;
    }
  };
}

export function generate7BagQueue(seed, count = 100) {
  const rng = createTetrioPRNG(seed);
  const minotypes = ["z", "l", "o", "s", "i", "j", "t"];
  const bag = [];
  const out = [];

  function populateBag() {
    const nextBag = [...minotypes];
    rng.shuffleArray(nextBag);
    bag.push(...nextBag);
  }

  while (out.length < count) {
    while (bag.length < 14) {
      populateBag();
    }
    out.push(bag.shift());
  }

  return out;
}

export function isSevenBagBagType(bagtype) {
  const normalized = String(bagtype ?? "")
    .trim()
    .toLowerCase();
  return normalized === "7-bag" || normalized === "7bag" || normalized === "bag7";
}

export function getCurrentAndNext(seed, pieceIndex, count = 6) {
  const queue = generate7BagQueue(seed, pieceIndex + count + 1);
  const current = queue[pieceIndex];
  const next = queue.slice(pieceIndex + 1, pieceIndex + 1 + count);

  return {
    current: current.toUpperCase(),
    queue: next.map((piece) => piece.toUpperCase()),
    fullQueue: queue.map((piece) => piece.toUpperCase())
  };
}
