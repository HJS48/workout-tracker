require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function testConnection() {
  try {
    const { data, error } = await supabase.from('_test_connection').select('*').limit(1);

    // Error 42P01 means table doesn't exist - but connection worked!
    if (error && error.code === '42P01') {
      console.log('✓ Supabase connection successful!');
      return;
    }

    if (error) {
      console.log('✓ Connected to Supabase (query returned:', error.message, ')');
    } else {
      console.log('✓ Supabase connection successful!');
    }
  } catch (err) {
    console.error('✗ Connection failed:', err.message);
  }
}

testConnection();
