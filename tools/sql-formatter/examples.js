// Example queries for the dropdown (plain data, no DOM).
export const EXAMPLES = [
  {
    id: 'select-join', label: 'SELECT with JOINs',
    sql: "select u.id, u.name, count(o.id) as orders, sum(o.total) as revenue from users u inner join orders o on o.user_id = u.id and o.status = 'paid' left join coupons c on c.id = o.coupon_id where u.created_at >= '2024-01-01' and (u.country = 'US' or u.country = 'CA') group by u.id, u.name having count(o.id) > 2 order by revenue desc limit 20 offset 40;",
  },
  {
    id: 'subquery', label: 'Subquery + CASE',
    sql: "SELECT p.name, CASE WHEN p.stock = 0 THEN 'out' WHEN p.stock < 10 THEN 'low' ELSE 'ok' END AS stock_state, (SELECT AVG(price) FROM products WHERE category_id = p.category_id) AS category_avg FROM products p WHERE p.id IN (SELECT product_id FROM order_items WHERE qty > 5) AND p.price BETWEEN 10 AND 100;",
  },
  {
    id: 'cte', label: 'CTE (WITH)',
    sql: "with recent as (select * from orders where created_at > now() - interval '30 days'), totals as (select user_id, sum(total) as spent from recent group by user_id) select u.email, t.spent from users u join totals t on t.user_id = u.id order by t.spent desc",
  },
  {
    id: 'insert', label: 'INSERT ... VALUES',
    sql: "insert into users (name, email, active) values ('Ann', 'ann@example.com', true), ('Bob O''Neil', 'bob@example.com', false);",
  },
  {
    id: 'update-delete', label: 'UPDATE and DELETE',
    sql: "update accounts set balance = balance - 100, updated_at = now() where id = 42 and balance >= 100; delete from sessions where expires_at < now();",
  },
  {
    id: 'create', label: 'CREATE TABLE',
    sql: "create table if not exists invoices (id bigint primary key, customer_id int not null references customers(id), amount decimal(10,2) not null default 0, status varchar(20) default 'draft', created_at timestamp default current_timestamp, unique (customer_id, id));",
  },
  {
    id: 'union', label: 'UNION with comments',
    sql: "-- active and archived users\nselect id, email from users /* live table */ where active = 1\nunion all\nselect id, email from users_archive where deleted_at is null -- keep\norder by email;",
  },
];
