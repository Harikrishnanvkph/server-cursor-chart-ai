import dotenv from 'dotenv';
import dns from 'node:dns';

dotenv.config();

// Ensure Node.js resolves IPv4 addresses first to avoid NAT64/IPv6 timeout issues with Supabase
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

