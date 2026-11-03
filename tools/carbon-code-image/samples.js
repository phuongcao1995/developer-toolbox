// Short sample snippets per language (plain data).
export const SAMPLES = {
  javascript: `// Debounce a function call
export function debounce(fn, wait = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

const onResize = debounce(() => console.log(\`width: \${window.innerWidth}px\`), 250);
window.addEventListener('resize', onResize);`,
  typescript: `interface User {
  id: number;
  name: string;
  email?: string;
}

async function loadUser(id: number): Promise<User | null> {
  const res = await fetch(\`/api/users/\${id}\`);
  return res.ok ? ((await res.json()) as User) : null;
}`,
  python: `from dataclasses import dataclass

@dataclass
class Point:
    x: float
    y: float

    def distance_to(self, other: "Point") -> float:
        """Euclidean distance."""
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5

print(Point(0, 0).distance_to(Point(3, 4)))  # 5.0`,
  html: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Hello</title>
  </head>
  <body class="home">
    <!-- greeting -->
    <h1 id="title">Hello, world!</h1>
    <a href="https://example.com">Read more &rarr;</a>
  </body>
</html>`,
  css: `:root {
  --brand: #4261ee;
}

.card > .title:hover {
  color: var(--brand);
  margin: 0 auto;
  padding: 1.5rem 2rem;
  background: linear-gradient(135deg, #fff 0%, #eee 100%);
}

@media (max-width: 600px) {
  .card { display: none !important; }
}`,
  json: `{
  "name": "developer-toolbox",
  "version": "1.2.0",
  "private": true,
  "scripts": { "start": "serve ." },
  "keywords": ["tools", "html"],
  "license": null
}`,
  sql: `SELECT u.id, u.name, COUNT(o.id) AS orders
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.created_at >= '2024-01-01' -- recent users
GROUP BY u.id, u.name
ORDER BY orders DESC
LIMIT 10;`,
  bash: `#!/usr/bin/env bash
set -euo pipefail

for file in ./logs/*.log; do
  echo "Compressing $file"
  gzip -9 "$file"
done

if [ -d ./dist ]; then rm -rf ./dist; fi
npm run build --silent`,
  java: `@RestController
public class HelloController {
    private final GreetingService service;

    @GetMapping("/hello")
    public String hello(@RequestParam(defaultValue = "world") String name) {
        // delegate to the service
        return service.greet(name);
    }
}`,
  csharp: `public record Order(int Id, decimal Total);

public static class Report
{
    public static decimal Sum(IEnumerable<Order> orders) =>
        orders.Where(o => o.Total > 0).Sum(o => o.Total);
}`,
  go: `package main

import "fmt"

func fib(n int) int {
	if n < 2 {
		return n
	}
	return fib(n-1) + fib(n-2)
}

func main() {
	fmt.Println("fib(10) =", fib(10))
}`,
  rust: `#[derive(Debug)]
struct Point { x: f64, y: f64 }

impl Point {
    fn norm(&self) -> f64 {
        (self.x * self.x + self.y * self.y).sqrt()
    }
}

fn main() {
    let p = Point { x: 3.0, y: 4.0 };
    println!("{:?} -> {}", p, p.norm());
}`,
  php: `<?php
declare(strict_types=1);

function greet(string $name = "world"): string {
    // build the greeting
    return sprintf("Hello, %s!", ucfirst($name));
}

echo greet("developer");`,
  plain: `Any text you paste here is rendered
without syntax highlighting.`,
};
