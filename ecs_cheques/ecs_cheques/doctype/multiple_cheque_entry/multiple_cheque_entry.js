// Copyright (c) 2021, erpcloud.systems and contributors
// For license information, please see license.txt

frappe.ui.form.on("Multiple Cheque Entry", {
    setup: function(frm) {
        frm.set_query("bank_acc", () => ({
            filters: [["Bank Account", "bank", "in", frm.doc.cheque_bank]]
        }));
        frm.set_query("cheque_bank", () => ({
            filters: [["Bank", "company_bank", "=", '1']]
        }));
        frm.set_query("mode_of_payment", () => ({
            filters: [["Mode of Payment", "type", "=", 'Cheque']]
        }));
        frm.set_query("party_type", () => ({
            filters: [["DocType", "name", "in", ["Customer", "Supplier"]]]
        }));
    }
});

frappe.ui.form.on("Multiple Cheque Entry", {
    party_type: function(frm) {
        frm.set_value("party", "");
        frm.set_value("party_name", "");
    },
    cheque_bank: function(frm) {
        frm.set_value("bank_acc", "");
        frm.set_value("account", "");
        frm.set_value("collection_fee_account", "");
        frm.set_value("payable_account", "");
    },
    bank_acc: function(frm) {
        frm.set_value("account", "");
        frm.set_value("collection_fee_account", "");
        frm.set_value("payable_account", "");
    },
    payment_type: function(frm) {
        if (frm.doc.payment_type === "Receive") {
            frm.set_value("party_type", "Customer");
        }
        if (frm.doc.payment_type === "Pay") {
            frm.set_value("party_type", "Supplier");
        }
    },
    party: function(frm) {
        if (!frm.doc.party_type || !frm.doc.party) return;
        const doctype = frm.doc.party_type === "Customer" ? "Customer" : "Supplier";
        const fieldname = frm.doc.party_type === "Customer" ? "customer_name" : "supplier_name";
        frappe.call({
            method: "frappe.client.get_value",
            args: { doctype, fieldname, filters: { name: frm.doc.party } },
            callback: function(r) {
                frm.set_value("party_name", r.message ? r.message[fieldname] : "");
            }
        });
    },
    validate: function(frm) {
        if (frm.doc.mode_of_payment_type !== "Cheque") {
            frappe.throw("The selected Mode of Payment is not Cheque. Please select a Cheque type.");
        }
    }
});

// -------- On Submit for Payment Entries --------
frappe.ui.form.on("Multiple Cheque Entry", "on_submit", function(frm) {
    const isPay = frm.doc.payment_type === "Pay";
    const isReceive = frm.doc.payment_type === "Receive";
    const table = isPay ? frm.doc.cheque_table_2 : frm.doc.cheque_table;
    if (!table || !table.length) return;

    // Use custom Account Paid To if provided (fieldname: account_paid_to)
    // Use custom Account Currency if provided (fieldname: account_currency)
    const accountPaidTo = frm.doc.account_paid_to; // <-- your custom "Account Paid To" field
    const accountCurrency = frm.doc.account_currency; // <-- your custom "Account Currency" field

    let docs = [];
    table.forEach(row => {
        if (!row.payment_entry) {
            // Decide paid_from / paid_to using existing fields but override with custom ones when present
            const paid_to_value = accountPaidTo || frm.doc.paid_to || frm.doc.payable_account || frm.doc.account;
            // Optionally add logic for paid_from override if you created "account_paid_from":
            // const accountPaidFrom = frm.doc.account_paid_from;
            const paid_from_value = isReceive ? (frm.doc.paid_from || frm.doc.account) : (frm.doc.payable_account || frm.doc.account);

            const new_doc = {
                doctype: "Payment Entry",
                posting_date: frm.doc.posting_date,
                reference_doctype: "Multiple Cheque Entry",
                reference_link: frm.doc.name,
                payment_type: frm.doc.payment_type,
                mode_of_payment: frm.doc.mode_of_payment,
                mode_of_payment_type: frm.doc.mode_of_payment_type,
                party_type: frm.doc.party_type,
                party: frm.doc.party,
                // set paid_from / paid_to
                paid_from: paid_from_value,
                paid_to: paid_to_value,
                // also keep bank / cheque details if present
                cheque_bank: frm.doc.cheque_bank,
                bank_acc: frm.doc.bank_acc,
                cheque_type: row.cheque_type,
                reference_no: row.reference_no,
                reference_date: row.reference_date,
                paid_amount: row.paid_amount,
                received_amount: row.paid_amount,
                first_beneficiary: row.first_beneficiary,
                person_name: row.person_name,
                issuer_name: row.issuer_name,
                picture_of_check: row.picture_of_check,
                cheque_table_no: isReceive ? row.name : undefined,
                cheque_table_no2: isPay ? row.name : undefined
            };

            // If user supplied a single account currency, set account-currency fields for both sides.
            // Field names used here are the typical ones used by Payment Entry in client scripts.
            // If your ERPNext version uses slightly different fieldnames, adjust accordingly.
            if (accountCurrency) {
                new_doc.paid_to_account_currency = accountCurrency;
                new_doc.paid_from_account_currency = accountCurrency;
                // also set company_currency if you want, but usually not necessary:
                // new_doc.company_currency = frm.doc.company_currency || accountCurrency;
            }

            docs.push(new_doc);
        }
    });

    // Insert & Submit Each Entry Properly
    const funcs = docs.map(doc =>
        frappe.call({
            method: "frappe.client.insert",
            args: { doc },
            callback: function(inserted) {
                if (inserted.message) {
                    frappe.call({
                        method: "frappe.client.submit",
                        args: { doc: inserted.message },
                        callback: function(submitted) {
                            if (submitted.message) {
                                const child_doctype = isPay ? "Cheque Table Pay" : "Cheque Table Receive";
                                const child_name = doc.cheque_table_no || doc.cheque_table_no2;
                                // ensure existence check
                                if (child_name) {
                                    frappe.db.set_value(child_doctype, child_name, "payment_entry", submitted.message.name);
                                }
                            }
                        }
                    });
                }
            }
        })
    );

    Promise.all(funcs).then(() => {
        frappe.msgprint("تم إنشاء الشيكات بنجاح ... برجاء مراجعة المدفوعات والمقبوضات.");
        frm.reload_doc();
    }).catch(err => {
        // show an error if any
        console.error(err);
        frappe.msgprint({ title: __('Error'), message: __('حدث خطأ أثناء إنشاء أو تقديم قيود الدفع. راجع السجل.') });
    });
});

// -------- First Beneficiary Auto-Fill --------
frappe.ui.form.on("Cheque Table Pay", "first_beneficiary", function(frm) {
    frm.doc.cheque_table_2?.forEach(r => {
        r.person_name = frm.doc.party_name;
        r.issuer_name = frm.doc.company;
    });
    frm.refresh_field("cheque_table_2");
});

frappe.ui.form.on("Cheque Table Receive", "first_beneficiary", function(frm) {
    frm.doc.cheque_table?.forEach(r => {
        r.person_name = frm.doc.company;
        r.issuer_name = frm.doc.party_name;
    });
    frm.refresh_field("cheque_table");
});
