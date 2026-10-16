-- The Worker (store_server) records when a supplier's offer ends (a virtual
-- number's lifetime, 0019); orders' columns are granted one by one.
grant update (supplier_expires_at) on app.orders to store_server;
