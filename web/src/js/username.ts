// Client-side username store & generator with friendly animal names
const ADJECTIVES = ["swift", "quiet", "cozy", "bright", "clever", "bold", "wild", "mellow", "calm", "daring", "gentle", "frosty"];
const ANIMALS = ["otter", "falcon", "badger", "fox", "lynx", "panda", "koala", "gecko", "sparrow", "seal", "robin", "finch"];

export function generateRandomUsername(): string {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const num = Math.floor(Math.random() * 90) + 10;
    return `${adj}-${animal}-${num}`;
}

export function getStoredUsername(): string {
    let name = localStorage.getItem("doot_username");
    if (!name || !name.trim()) {
        name = generateRandomUsername();
        localStorage.setItem("doot_username", name);
    }
    return name;
}

export function setStoredUsername(name: string): string {
    const clean = name.trim() || generateRandomUsername();
    localStorage.setItem("doot_username", clean);
    return clean;
}
