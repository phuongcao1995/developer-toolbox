// Sample queries for the SQL Query Analyzer. Pure data.
export const EXAMPLES = [
  { id: 'slow-report', label: 'Report with several anti-patterns', dialect: 'mysql', sql: `SELECT DISTINCT u.name, COUNT(o.id) AS orders,
  (SELECT MAX(p.paid_at) FROM payments p WHERE p.user_id = u.id) AS last_paid
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
JOIN order_items i ON i.order_id = o.id
WHERE YEAR(u.created_at) = 2024
  AND u.email LIKE '%@example.com'
  AND o.status = 'shipped'
  AND u.id NOT IN (SELECT user_id FROM banned_users)
GROUP BY u.id
HAVING u.id > 100
ORDER BY RAND()
LIMIT 20 OFFSET 5000;` },
  { id: 'good-query', label: 'Well-formed query with index candidates', dialect: 'postgresql', sql: `SELECT o.id, o.total, o.created_at
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'open'
  AND o.created_at >= '2024-01-01'
  AND c.country = 'DE'
ORDER BY o.created_at DESC
LIMIT 50;` },
  { id: 'cte', label: 'CTE with join and aggregation', dialect: 'standard', sql: `WITH recent AS (
  SELECT customer_id, SUM(total) AS spent
  FROM orders
  WHERE created_at > '2024-06-01'
  GROUP BY customer_id
)
SELECT c.name, r.spent
FROM customers c
JOIN recent r ON r.customer_id = c.id
WHERE r.spent > 1000
ORDER BY r.spent DESC;` },
  { id: 'union-null', label: 'UNION, = NULL and NOT IN', dialect: 'standard', sql: `SELECT id, name FROM customers WHERE deleted_at = NULL
UNION
SELECT id, name FROM suppliers WHERE id NOT IN (SELECT supplier_id FROM blocked WHERE reason = 'fraud');` },
];
